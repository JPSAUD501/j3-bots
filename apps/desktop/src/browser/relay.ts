// SPDX-License-Identifier: AGPL-3.0-or-later
// How a tab's page is reached by Playwright follows T3 Code v0.1.13,
// apps/desktop/src/preview/DesktopBrowserHost.ts (MIT License, Copyright (c) 2026
// T3 Tools Inc.; see apps/desktop/NOTICE): the page's own debugger, behind
// the CDP relay, on a loopback socket only this process connects to. Changed here:
// the socket is one-use on a random path, and a page that closes itself is reported
// detached (phase 0).
import { createCdpRelayConnection } from "@j3-bots/browser";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { WebContents } from "electron";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { WebSocketServer } from "ws";

/** Why Playwright could not reach a tab's page. */
export class RelayFailed extends Schema.TaggedError<RelayFailed>()("RelayFailed", {
  detail: Schema.String,
}) {}

/** What a host learns of a page's debugger traffic, beyond what Playwright sees. */
export interface RelayHooks {
  /**
   * A command is about to go to the page. Told before it is sent, as the
   * page may act on it while it is being sent; what it answers runs once
   * the page has answered it, or failed to.
   */
  readonly sending: (method: string, params: Readonly<Record<string, unknown>>) => () => void;
}

/** A tab's page, as the driver drives it. */
export interface RelayedPage {
  readonly browser: Browser;
  readonly page: Page;
  /** A CDP session of the page, for the driver alone. */
  readonly cdp: CDPSession;
}

const TargetInfo = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
const decodeTargetInfo = Schema.decodeUnknownEffect(TargetInfo);

const CONNECT_TIMEOUT_MS = 15_000;
/** What CDP lets one message carry; Playwright's own limit is the same. */
const MAX_MESSAGE = 256 * 1024 * 1024;

const targetIdOf = (contents: WebContents) =>
  Effect.tryPromise({
    try: () => contents.debugger.sendCommand("Target.getTargetInfo"),
    catch: (cause) => new RelayFailed({ detail: `The page has no target: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap(decodeTargetInfo),
    Effect.map(({ targetInfo }) => targetInfo.targetId),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new RelayFailed({ detail: error.message })),
    ),
  );

/**
 * Playwright on `contents`, for as long as the scope lives: its debugger,
 * which the caller has attached, behind the relay, on a loopback socket
 * with a random path that one connection, this process's own, may use
 * once. Connect only after the page's first load: a connection during the
 * first commit misses it.
 */
export const relayPage = (
  contents: WebContents,
  hooks: RelayHooks,
): Effect.Effect<RelayedPage, RelayFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const targetId = yield* targetIdOf(contents);
    const path = `/${Buffer.from(SecureRandom.randomBytesUnsafe(24)).toString("base64url")}`;
    const server = yield* Effect.acquireRelease(
      Effect.callback<WebSocketServer, RelayFailed>((resume) => {
        const listening = new WebSocketServer({
          host: "127.0.0.1",
          port: 0,
          path,
          maxPayload: MAX_MESSAGE,
        });
        listening.once("listening", () => resume(Effect.succeed(listening)));
        listening.once("error", (cause) =>
          resume(Effect.fail(new RelayFailed({ detail: cause.message }))),
        );
      }),
      (listening) => Effect.sync(() => listening.close()),
    );
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      return yield* new RelayFailed({ detail: "The relay has no port." });
    }

    const screencasts = new Set<string | undefined>();
    let used = false;
    server.on("connection", (socket) => {
      // One use: only the Playwright in this process connects, once.
      if (used) {
        socket.close();
        return;
      }
      used = true;
      const relay = createCdpRelayConnection(
        {
          send: (method, params, sessionId, owner) => {
            if (sessionId === undefined && method === "Page.startScreencast")
              screencasts.add(owner);
            if (sessionId === undefined && method === "Page.stopScreencast") {
              screencasts.delete(owner);
            }
            const answered = hooks.sending(method, params);
            try {
              const reply: Promise<unknown> = contents.debugger.sendCommand(
                method,
                params,
                sessionId,
              );
              reply.then(answered, answered);
              return reply;
            } catch (cause) {
              answered();
              throw cause;
            }
          },
          sessionDetached: (owner) => screencasts.delete(owner),
          receivesScreencast: (owner) => screencasts.has(owner),
          ackScreencastFrame: (frameId) =>
            void contents.debugger
              .sendCommand("Page.screencastFrameAck", { sessionId: frameId })
              .catch(() => undefined),
          targetId: () => Promise.resolve(targetId),
          url: () => contents.getURL(),
          title: () => contents.getTitle(),
          userAgent: () => contents.getUserAgent(),
          // Downloads are placed by the host itself (`will-download`).
          setDownloadDirectory: () => undefined,
        },
        (message) => socket.send(message),
        () => socket.close(),
      );
      const onMessage = (
        _event: Electron.Event,
        method: string,
        params: unknown,
        sessionId: string,
      ) => relay.event(method, params, sessionId === "" ? undefined : sessionId);
      contents.debugger.on("message", onMessage);
      socket.on("message", (data, binary) => {
        if (!binary) relay.receive(data.toString());
      });
      // A page that closes itself, as a sign-in pop-up does, leaves the
      // debugger's commands unanswered: Playwright hears the page went.
      const onDestroyed = () => relay.pageDestroyed(targetId);
      contents.once("destroyed", onDestroyed);
      socket.on("close", () => {
        contents.off("destroyed", onDestroyed);
        if (!contents.isDestroyed()) contents.debugger.off("message", onMessage);
      });
    });

    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          chromium.connectOverCDP(`ws://127.0.0.1:${address.port}${path}`, {
            isLocal: true,
            timeout: CONNECT_TIMEOUT_MS,
          }),
        catch: (cause) =>
          new RelayFailed({ detail: `Playwright did not connect: ${String(cause)}` }),
      }),
      (connected) => Effect.promise(() => connected.close().catch(() => undefined)),
    );
    const page = browser.contexts()[0]?.pages()[0];
    if (page === undefined) return yield* new RelayFailed({ detail: "The relay showed no page." });
    const cdp = yield* Effect.tryPromise({
      try: () => page.context().newCDPSession(page),
      catch: (cause) => new RelayFailed({ detail: `No CDP session of the page: ${String(cause)}` }),
    });
    return { browser, page, cdp };
  });
