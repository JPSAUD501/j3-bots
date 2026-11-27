// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from T3 Code v0.1.13, apps/desktop/src/preview/CdpRelay.ts (MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see this package's NOTICE). Changed here: the
// messages are decoded with schemas instead of cast, the session ids are J3 Bots' own,
// and `pageDestroyed` reports a page that closed itself.
//
// It makes one page's debugger look like a whole browser to Playwright's
// `connectOverCDP`: the desktop app runs one per tab, on a one-use loopback
// socket only its own process connects to (decision 0110).
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What a relay refuses when asked to attach to anything but its page; the driver reads frames another way then. */
export const RELAY_PAGE_ONLY = "Only this tab's page can be attached.";

/** The page a relay serves. Electron allows one debugger per page, so the host shares its own. */
export interface CdpRelayTarget {
  readonly send: (
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
    /** The extra page session that sent it, such as a viewer's; the main connection has none. */
    owner?: string,
  ) => Promise<unknown>;
  readonly sessionDetached?: (owner: string) => void;
  /** Whether a page session, by owner as `send` names it, gets the page's screencast frames. */
  readonly receivesScreencast: (owner: string | undefined) => boolean;
  /** Acknowledges a native screencast frame, letting Chromium send the next. */
  readonly ackScreencastFrame: (frameId: number) => void;
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
  readonly userAgent: () => string;
  /** Where downloads go; the desktop and its relay share a disk, so paths need no translation. */
  readonly setDownloadDirectory: (directory: string | null) => void;
}

export interface CdpRelayConnection {
  /** A message from Playwright. */
  readonly receive: (raw: string) => void;
  /** An event from the page's debugger; `sessionId` is a child frame's or worker's. */
  readonly event: (method: string, params: unknown, sessionId: string | undefined) => void;
  /**
   * The page is gone, as when a sign-in pop-up closes itself. Its debugger
   * leaves commands in flight unanswered, which would hold Playwright
   * forever, so the relay reports the target detached and closes.
   */
  readonly pageDestroyed: (targetId: string) => void;
}

const Params = Schema.Record(Schema.String, Schema.Unknown);
type Params = typeof Params.Type;

const CdpCommand = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optionalKey(Params),
  sessionId: Schema.optionalKey(Schema.String),
});
type CdpCommand = typeof CdpCommand.Type;

const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(CdpCommand));
/** A message's id and session, read apart, to answer one that is no command. */
const decodeAddress = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Number, sessionId: Schema.optionalKey(Schema.String) }),
  ),
);
const isParams = Schema.is(Params);

// CDP values are plain JSON data, so their serialized size can be bounded before
// JSON.stringify allocates it. A string counts at its length unless it holds a
// character JSON may escape, which can take six code units.
const MAX_CDP_PAYLOAD_SIZE = 64 * 1024 * 1024;
const MAY_ESCAPE = /[^\x20\x21\x23-\x5b\x5d-퟿-￿]/;
const serializedSize = (text: string) =>
  (MAY_ESCAPE.test(text) ? text.length * 6 : text.length) + 3;

const fitsPayloadBudget = (message: unknown) => {
  let remaining = MAX_CDP_PAYLOAD_SIZE;
  const visit = (value: unknown): boolean => {
    remaining -= typeof value === "string" ? serializedSize(value) : 26;
    if (remaining < 0) return false;
    if (typeof value !== "object" || value === null) return true;
    if (Array.isArray(value)) return value.every(visit);
    return Object.entries(value).every(([key, item]) => {
      remaining -= serializedSize(key);
      return visit(item);
    });
  };
  return visit(message);
};

const BROWSER_CONTEXT_ID = "j3-tab";
const PAGE_SESSION_ID = "j3-tab-page";

const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.cancelDownload",
]);

/** A command's answer, and an event to send right after it. */
interface Answer {
  readonly result: unknown;
  readonly announce?: Params;
}

const answer = (result: unknown): Answer => ({ result });

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
  close: () => void,
): CdpRelayConnection {
  let closed = false;
  const send = (message: Params) => {
    if (closed) return;
    if (fitsPayloadBudget(message)) {
      write(JSON.stringify(message));
      return;
    }
    // An error reply fails only that command. A dropped event would leave
    // Playwright out of step with the page, so the relay closes instead.
    const id = message["id"];
    if (typeof id === "number") {
      const sessionId = message["sessionId"];
      write(
        JSON.stringify({
          id,
          error: { code: -32000, message: "CDP payload too large" },
          ...(typeof sessionId === "string" ? { sessionId } : {}),
        }),
      );
      return;
    }
    closed = true;
    close();
  };
  let attached = false;
  let downloadEventsEnabled = false;
  /** Relay-made page sessions share one real debugger; child frame sessions keep their own ids. */
  const sessions = new Map<string, "browser" | "page">([[PAGE_SESSION_ID, "page"]]);
  // Each page session holds one unacknowledged frame and keeps the newest one skipped meanwhile.
  const unackedFrames = new Map<string, number>();
  const skippedFrames = new Map<string, { readonly frameId: number; readonly params: Params }>();
  // Chromium keeps a few frames in flight and reuses one frame id per run, so pacing it means
  // leaving frames every session is busy for unacknowledged and releasing one per consumer ack.
  const heldNativeFrames: Array<number> = [];
  const releaseHeldFramesWithoutHolders = () => {
    if (skippedFrames.size === 0)
      for (const frameId of heldNativeFrames.splice(0)) target.ackScreencastFrame(frameId);
  };
  const sendFrame = (sessionId: string, frameId: number, params: Params) => {
    unackedFrames.set(sessionId, frameId);
    send({ method: "Page.screencastFrame", params, sessionId });
  };
  let sessionSequence = 0;
  const newSession = (kind: "browser" | "page") => {
    const sessionId = `j3-tab-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  const targetInfo = async () => ({
    targetId: await target.targetId(),
    type: "page",
    title: target.title(),
    url: target.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const browserCommand = async (command: CdpCommand): Promise<Answer> => {
    if (ACKNOWLEDGED.has(command.method)) return answer({});
    switch (command.method) {
      case "Browser.setDownloadBehavior": {
        const directory = command.params?.["downloadPath"];
        const deny = command.params?.["behavior"] === "deny";
        // Browser-scoped behavior would target the app's own session; the tab's downloads are placed by the host.
        const result = await target.send(
          "Page.setDownloadBehavior",
          { behavior: deny ? "deny" : "default" },
          undefined,
        );
        target.setDownloadDirectory(!deny && typeof directory === "string" ? directory : null);
        downloadEventsEnabled = command.params?.["eventsEnabled"] === true;
        return answer(result);
      }
      case "Browser.getVersion":
        return answer({
          protocolVersion: "1.3",
          product: "Electron",
          revision: "",
          userAgent: target.userAgent(),
          jsVersion: "",
        });
      case "Target.getTargetInfo":
        return answer({
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          },
        });
      case "Target.getBrowserContexts":
        return answer({ browserContextIds: [] });
      case "Target.getTargets":
        return answer({ targetInfos: [await targetInfo()] });
      case "Target.attachToBrowserTarget":
        return answer({ sessionId: newSession("browser") });
      case "Target.attachToTarget": {
        if (command.params?.["targetId"] !== (await target.targetId()))
          throw new Error(RELAY_PAGE_ONLY);
        return answer({ sessionId: newSession("page") });
      }
      case "Target.detachFromTarget": {
        const sessionId = command.params?.["sessionId"];
        if (typeof sessionId === "string" && sessionId !== PAGE_SESSION_ID) {
          sessions.delete(sessionId);
          unackedFrames.delete(sessionId);
          skippedFrames.delete(sessionId);
          releaseHeldFramesWithoutHolders();
          target.sessionDetached?.(sessionId);
        }
        return answer({});
      }
      case "Target.setAutoAttach": {
        if (attached) return answer({});
        attached = true;
        return {
          result: {},
          announce: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: PAGE_SESSION_ID,
              targetInfo: await targetInfo(),
              waitingForDebugger: false,
            },
          },
        };
      }
      default:
        throw new Error(`Not supported for a J3 Bots tab: ${command.method}`);
    }
  };

  let runtimeReset: Promise<unknown> | undefined;

  const pageCommand = async (command: CdpCommand, sessionId: string): Promise<Answer> => {
    const child = sessions.get(sessionId) === "page" ? undefined : sessionId;
    const owner = child === undefined && sessionId !== PAGE_SESSION_ID ? sessionId : undefined;
    const params = command.params ?? {};
    // Child frames and workers pause on auto-attach until resumed; only the page can skip this.
    if (command.method === "Runtime.runIfWaitingForDebugger" && child === undefined)
      return answer({});
    // Playwright asks for this on every page; the host emulates focus only while it is in use.
    if (command.method === "Emulation.setFocusEmulationEnabled") return answer({});
    if (command.method === "Page.screencastFrameAck" && child === undefined) {
      // A restart keeps the slot too, or restarting would let frames past an unacknowledged one.
      if (unackedFrames.get(sessionId) === params["sessionId"]) {
        unackedFrames.delete(sessionId);
        const skipped = skippedFrames.get(sessionId);
        skippedFrames.delete(sessionId);
        if (
          skipped !== undefined &&
          target.receivesScreencast(sessionId === PAGE_SESSION_ID ? undefined : sessionId)
        )
          sendFrame(sessionId, skipped.frameId, skipped.params);
        const released = heldNativeFrames.shift();
        if (released !== undefined) target.ackScreencastFrame(released);
      }
      return answer({});
    }
    if (command.method === "Page.stopScreencast" && child === undefined) {
      skippedFrames.delete(sessionId);
      releaseHeldFramesWithoutHolders();
    }
    // The shared debugger keeps Runtime enabled after an earlier connection, and a repeated
    // enable reports no existing contexts; Playwright waits for them, so reset once per connection.
    if (command.method === "Runtime.enable" && child === undefined) {
      runtimeReset ??= target.send("Runtime.disable", {}, undefined, owner).catch(() => undefined);
      await runtimeReset;
      return answer(await target.send(command.method, params, undefined, owner));
    }
    return answer(await target.send(command.method, params, child, owner));
  };

  return {
    receive: (raw) => {
      if (closed) return;
      const decoded = decodeCommand(raw);
      if (Option.isNone(decoded)) {
        // Playwright waits for a reply to every id it sent; one that cannot be read gets an error.
        const address = decodeAddress(raw);
        if (Option.isSome(address))
          send({
            id: address.value.id,
            error: { code: -32600, message: "Not a CDP command." },
            ...(address.value.sessionId === undefined
              ? {}
              : { sessionId: address.value.sessionId }),
          });
        return;
      }
      const command = decoded.value;
      const sessionId = command.sessionId;
      const answered =
        sessionId === undefined || sessions.get(sessionId) === "browser"
          ? browserCommand(command)
          : pageCommand(command, sessionId);
      const route = sessionId === undefined ? {} : { sessionId };
      // Reply as commands finish, so a slow command never holds a later reply.
      void answered.then(
        ({ result, announce }) => {
          send({ id: command.id, result: result ?? {}, ...route });
          if (announce !== undefined) send(announce);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      );
    },
    event: (method, params, sessionId) => {
      if (!attached) return;
      const name = method.startsWith("Page.download")
        ? method.replace("Page.", "Browser.")
        : method;
      // Download events are the browser's; Playwright listens on its root session.
      if (name.startsWith("Browser.download")) {
        if (downloadEventsEnabled) send({ method: name, params });
        return;
      }
      // Electron reports the page's own events with an empty session id.
      if (sessionId) {
        send({ method: name, params, sessionId });
        return;
      }
      if (name === "Page.screencastFrame") {
        if (!isParams(params)) return;
        const frameId = params["sessionId"];
        if (typeof frameId !== "number") return;
        let held = false;
        let delivered = false;
        for (const [id, kind] of sessions) {
          if (kind !== "page") continue;
          if (!target.receivesScreencast(id === PAGE_SESSION_ID ? undefined : id)) continue;
          if (unackedFrames.has(id)) {
            skippedFrames.set(id, { frameId, params });
            held = true;
          } else {
            sendFrame(id, frameId, params);
            delivered = true;
          }
        }
        if (held && !delivered) heldNativeFrames.push(frameId);
        else target.ackScreencastFrame(frameId);
        return;
      }
      for (const [id, kind] of sessions)
        if (kind === "page") send({ method: name, params, sessionId: id });
    },
    pageDestroyed: (targetId) => {
      for (const [id, kind] of sessions)
        if (kind === "page")
          send({ method: "Target.detachedFromTarget", params: { sessionId: id, targetId } });
      closed = true;
      close();
    },
  };
}
