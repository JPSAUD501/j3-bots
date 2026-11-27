// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from T3 Code v0.1.13, apps/server/src/preview/ServerBrowserPage.ts (MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see this package's NOTICE): the snapshot and its refs
// per page generation, the actions, `evaluate`, `waitFor` and the net error codes.
import {
  type BrowserAction,
  type BrowserActOutcome,
  type BrowserDialog,
  type BrowserEvaluation,
  BrowserHostError,
  type BrowserImage,
  type BrowserLoadError,
  type BrowserNavigation,
  type BrowserPageInput,
  type BrowserPageSnapshot,
  type BrowserPageState,
  type BrowserReadiness,
  type BrowserScreencastFrame,
  type BrowserTabRef,
  type BrowserWaitCondition,
  DEFAULT_BROWSER_TIMEOUT_MS,
  MAX_BROWSER_EVALUATE_RESULT_BYTES,
  MAX_BROWSER_SNAPSHOT_LENGTH,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { CDPSession, Dialog, Frame, Page, Request } from "playwright-core";
import { addressOf } from "./address.ts";
import {
  documentState,
  editableAt,
  focusTextTarget,
  pageHasText,
  scrollPage,
  viewportSize,
} from "./pageScripts.ts";
import { hostErrorOf } from "./errors.ts";
import { handleTarget, locatorTarget, type Target } from "./target.ts";
import { FramesChanged, openReaders, type FrameReader } from "./frames.ts";
import {
  dottedPattern,
  maskText,
  maskTree,
  withoutDataPayload,
  withoutTreeDataPayloads,
} from "./redact.ts";
import { imageSize, jsonBytes } from "./bytes.ts";

/** Where an action points while it runs, so a viewer can draw the acting bot's cursor. */
export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  action: "move" | "click",
) => Effect.Effect<void>;

const noPointer: PointerReporter = () => Effect.void;

/**
 * One tab's page, driven by J3 Bots: the same on the desktop's browser and
 * on the server's. It knows only Playwright's `Page` and the page's CDP
 * session, and nothing of which host runs it.
 */
export interface DriverPage {
  readonly tab: BrowserTabRef;
  readonly page: Page;
  /** The page now. */
  readonly state: Effect.Effect<BrowserPageState>;
  /**
   * The page after each navigation, load, failed load, and dialog opened or
   * closed, until the page closes. A title the page changes by itself shows
   * with the next of these.
   */
  readonly changes: Stream.Stream<BrowserPageState>;
  /**
   * The page as a bot reads it, with refs that hold until the document
   * changes. Hidden values are masked.
   */
  readonly snapshot: (options: {
    readonly includeImage: boolean;
  }) => Effect.Effect<BrowserPageSnapshot, BrowserHostError>;
  readonly act: (
    action: BrowserAction,
    pointer?: PointerReporter,
  ) => Effect.Effect<BrowserActOutcome, BrowserHostError>;
  readonly evaluate: (input: {
    readonly expression: string;
    readonly awaitPromise: boolean;
    readonly timeoutMs?: number | undefined;
  }) => Effect.Effect<BrowserEvaluation, BrowserHostError>;
  readonly waitFor: (condition: BrowserWaitCondition) => Effect.Effect<void, BrowserHostError>;
  readonly navigate: (
    to: BrowserNavigation,
    options: {
      readonly readiness?: BrowserReadiness | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ) => Effect.Effect<BrowserPageState, BrowserHostError>;
  readonly answerDialog: (
    accept: boolean,
    promptText?: string,
  ) => Effect.Effect<void, BrowserHostError>;
  readonly screenshot: (options: {
    readonly format: "png" | "jpeg";
    readonly quality?: number | undefined;
  }) => Effect.Effect<BrowserImage, BrowserHostError>;
  /** A person's input, from a viewer: it goes to the page as the browser's own input. */
  readonly input: (input: BrowserPageInput) => Effect.Effect<void, BrowserHostError>;
  /** Whether a tap at the point lands in a field that takes text. */
  readonly probe: (x: number, y: number) => Effect.Effect<boolean, BrowserHostError>;
  /**
   * The page's pictures while the stream runs. The next comes only after
   * `screencastAck` of the last, and only the newest waits meanwhile. One
   * stream at a time: a second, while one runs, is refused.
   */
  readonly screencast: (options: {
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  }) => Stream.Stream<BrowserScreencastFrame, BrowserHostError>;
  readonly screencastAck: (frame: number) => Effect.Effect<void>;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;
const FRAME_ANSWER_MS = 1_000;
const TARGET_COUNT_MS = 250;
const WAIT_POLL_MS = 100;
/** How long a ref's element may take to be found: it was on the page at the snapshot. */
const REF_LOOKUP_MS = 1_000;
/** Beyond an action's own time, for the steps Playwright gives no timeout of their own. */
const ACTION_GRACE_MS = 1_000;
const UNRESPONSIVE_SCRIPT_MS = 1_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_TARGET_CHARS = 200;
const TYPE_PIECE = 64;

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, BrowserHostError> =>
  Effect.tryPromise({ try: run, catch: hostErrorOf });

/** A failed read that the snapshot answers by starting again. */
class SnapshotPageChanged extends Schema.TaggedError<SnapshotPageChanged>()(
  "SnapshotPageChanged",
  {},
) {}

const pageChanged = () =>
  new BrowserHostError({
    reason: "page",
    detail: "The page changed while it was read. Take the snapshot again.",
  });

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

/** Chromium's net error in a failure's text, with its code. */
const parseNetError = (errorText: string) => {
  // Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
  const description = /ERR_[A-Z\d_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};

const NATIVE_REF = /\[ref=((?:f\d+)?e\d+)\]/g;

const isDocumentState = Schema.is(Schema.Struct({ title: Schema.String, loading: Schema.Boolean }));
const isViewport = Schema.is(
  Schema.Struct({ width: Schema.Finite, height: Schema.Finite, ratio: Schema.Finite }),
);
const isOptions = Schema.is(
  Schema.NullOr(Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String }))),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const isFramesChanged = Schema.is(FramesChanged);

const isTimeoutError = (error: BrowserHostError) => error.reason === "timeout";

/**
 * Drives `page`, as the tab `tab`, for as long as the scope lives. `cdp`
 * is a CDP session of the page that the driver may use alone; the host
 * opens it, since only the host knows how.
 */
export const makeDriverPage = (options: {
  readonly tab: BrowserTabRef;
  readonly page: Page;
  readonly cdp: CDPSession;
}): Effect.Effect<DriverPage, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { tab, page, cdp } = options;

    // Refs carry a namespace of this driver and a count of the documents it has shown, so a
    // ref from another tab, an earlier document or before a restart never names an element
    // here. Within one document the browser keeps an element's number, so a ref holds
    // across snapshots until the main frame navigates or a frame detaches.
    const namespace = (yield* Random.nextIntBetween(0, 0x7fffffff)).toString(36);
    let sequence = 0;
    let generation = "";
    const refs = new Map<string, string>();
    /** Held while the browser numbers elements, and while a ref's element is looked up. */
    const refLock = yield* Semaphore.make(1);
    const forget = () => {
      generation = `${namespace}-${(++sequence).toString(36)}`;
      refs.clear();
    };
    forget();

    let dialog: Dialog | undefined;
    let loadError: BrowserLoadError | null = null;
    const frameSessions = new Map<Frame, Promise<CDPSession>>();

    const onFrameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      forget();
      // A new document has no dialog: one left open went with the page.
      dialog = undefined;
    };
    const onFrameDetached = (frame: Frame) => {
      forget();
      const session = frameSessions.get(frame);
      frameSessions.delete(frame);
      void session?.then((opened) => opened.detach()).catch(() => undefined);
    };
    const onDialog = (opened: Dialog) => {
      dialog = opened;
    };
    // Answered by anyone: the bot, or the person in the desktop's own view.
    const onDialogClosed = () => {
      dialog = undefined;
    };
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loadError = null;
    };
    const onRequestFailed = (request: Request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      const failure = request.failure()?.errorText ?? "";
      // A navigation the page or a new one replaced is no error of the page.
      if (failure.includes("ERR_ABORTED")) return;
      loadError = { url: withoutDataPayload(request.url()), ...parseNetError(failure) };
    };
    page.on("framenavigated", onFrameNavigated);
    page.on("framedetached", onFrameDetached);
    page.on("dialog", onDialog);
    page.on("request", onRequest);
    page.on("requestfailed", onRequestFailed);
    cdp.on("Page.javascriptDialogClosed", onDialogClosed);
    // The page's events reach this session only once it asks for them.
    yield* attempt(() => cdp.send("Page.enable")).pipe(Effect.ignore);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        cdp.off("Page.javascriptDialogClosed", onDialogClosed);
        for (const session of frameSessions.values())
          void session.then((opened) => opened.detach()).catch(() => undefined);
        frameSessions.clear();
        page.off("framenavigated", onFrameNavigated);
        page.off("framedetached", onFrameDetached);
        page.off("dialog", onDialog);
        page.off("request", onRequest);
        page.off("requestfailed", onRequestFailed);
      }),
    );

    const openDialog = (): BrowserDialog | null => {
      if (dialog === undefined) return null;
      const type = dialog.type();
      const kind =
        type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert";
      return { kind, message: dialog.message(), defaultValue: dialog.defaultValue() };
    };

    const state: Effect.Effect<BrowserPageState> = Effect.gen(function* () {
      const url = page.url();
      // A page that waits on a dialog runs no script: read nothing from it.
      const document =
        dialog === undefined
          ? yield* attempt(() => page.evaluate(documentState)).pipe(
              Effect.timeoutOption(1_000),
              Effect.map(Option.filter(isDocumentState)),
              Effect.orElseSucceed(Option.none),
            )
          : Option.none();
      return {
        tab,
        // Chromium's error page stands at an address of its own; the tab is still at the one that failed.
        url:
          url === "about:blank"
            ? ""
            : url.startsWith("chrome-error://")
              ? (loadError?.url ?? "")
              : withoutDataPayload(url),
        title: Option.match(document, { onNone: () => "", onSome: (read) => read.title }),
        loading: Option.match(document, { onNone: () => true, onSome: (read) => read.loading }),
        loadError,
        dialog: openDialog(),
      };
    });

    const changes = Stream.callback<void>((queue) =>
      Effect.gen(function* () {
        const changed = () => {
          Queue.offerUnsafe(queue, undefined);
        };
        const onNavigated = (frame: Frame) => {
          if (frame === page.mainFrame()) changed();
        };
        const onClose = () => {
          Queue.endUnsafe(queue);
        };
        page.on("framenavigated", onNavigated);
        page.on("domcontentloaded", changed);
        page.on("load", changed);
        page.on("dialog", changed);
        page.on("requestfailed", changed);
        page.on("close", onClose);
        cdp.on("Page.javascriptDialogClosed", changed);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            page.off("framenavigated", onNavigated);
            page.off("domcontentloaded", changed);
            page.off("load", changed);
            page.off("dialog", changed);
            page.off("requestfailed", changed);
            page.off("close", onClose);
            cdp.off("Page.javascriptDialogClosed", changed);
          }),
        );
      }),
    ).pipe(Stream.mapEffect(() => state));

    // ---------------------------------------------------------------------
    // Locating

    const deadlineIn = (timeoutMs: number | undefined) =>
      Effect.map(Clock.currentTimeMillis, (now) => now + (timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS));
    const remaining = (deadline: number) =>
      Effect.map(Clock.currentTimeMillis, (now) => Math.max(1, deadline - now));

    /**
     * The element a ref names, found once, under the lock the snapshot takes
     * while it numbers elements: the browser's own numbers start again in
     * each document, so a ref looked up again later could name another
     * element. Refused as stale when the ref is not one this document gave
     * out, or the element is gone.
     */
    const elementOf = (ref: string) =>
      Effect.acquireRelease(
        refLock.withPermits(1)(
          Effect.gen(function* () {
            const native = refs.get(ref);
            const taken = generation;
            if (native === undefined) return yield* new BrowserHostError({ reason: "stale-ref" });
            const handle = yield* attempt(() =>
              page.locator(`aria-ref=${native}`).elementHandle({ timeout: REF_LOOKUP_MS }),
            ).pipe(
              Effect.catchIf(
                (error) => error.reason === "timeout" || error.reason === "page",
                () => Effect.fail(new BrowserHostError({ reason: "stale-ref" })),
              ),
            );
            if (generation !== taken) {
              void handle.dispose().catch(() => undefined);
              return yield* new BrowserHostError({ reason: "stale-ref" });
            }
            return handle;
          }),
        ),
        (handle) => Effect.sync(() => void handle.dispose().catch(() => undefined)),
      );

    /**
     * What a target names. A ref goes alone, as `aria-ref=<ref>`; any other
     * mention of `aria-ref` is refused, so a ref never reaches the browser
     * except through `elementOf`.
     */
    const locate = (name: string): Effect.Effect<Target, BrowserHostError, Scope.Scope> => {
      if (!/aria-ref/i.test(name)) return Effect.succeed(locatorTarget(name, page.locator(name)));
      const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(name)?.[1];
      if (ref === undefined)
        return Effect.fail(
          new BrowserHostError({
            reason: "invalid-target",
            detail: "A ref goes alone, as aria-ref=<ref> from the latest snapshot.",
          }),
        );
      return Effect.map(elementOf(ref), (handle) => handleTarget(name, handle));
    };

    const viewport = Effect.gen(function* () {
      const read: unknown = yield* attempt(() => page.evaluate(viewportSize));
      return isViewport(read) ? read : { width: 1280, height: 800, ratio: 1 };
    });

    const targetPoint = Effect.fn("targetPoint")(function* (
      target: Target | undefined,
      at: { readonly x?: number | undefined; readonly y?: number | undefined },
    ) {
      if (target === undefined) return { x: at.x ?? 0, y: at.y ?? 0 };
      // A page that replaces the node mid-scroll fails it; the action after it says so.
      yield* attempt(() => target.scrollIntoView(2_000)).pipe(Effect.ignore);
      const box = yield* attempt(() => target.box(2_000)).pipe(Effect.orElseSucceed(() => null));
      if (box !== null) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const size = yield* viewport;
      return { x: size.width / 2, y: size.height / 2 };
    });

    /** The page's dialog opening: an action that opens one ends there, for the bot to answer it. */
    const dialogOpens = Effect.callback<void>((resume) => {
      const opened = () => resume(Effect.void);
      page.once("dialog", opened);
      return Effect.sync(() => page.off("dialog", opened));
    });

    /** A page that waits on a dialog runs no script: page work waits until it is answered. */
    const noDialog = Effect.suspend(() =>
      dialog === undefined
        ? Effect.void
        : Effect.fail(
            new BrowserHostError({
              reason: "refused",
              detail: "A dialog on the page waits for an answer. Answer it first.",
            }),
          ),
    );

    /**
     * Playwright's timeout names neither the target nor why it waited. The
     * click may still have happened, so the bot is told to look first.
     */
    const namedTimeout = (target: Target) => (error: BrowserHostError) =>
      Effect.gen(function* () {
        if (!isTimeoutError(error)) return yield* error;
        const quoted = `"${target.name}"`;
        const shown =
          quoted.length > MAX_TARGET_CHARS ? `${quoted.slice(0, MAX_TARGET_CHARS)}...` : quoted;
        const matches = yield* attempt(() => target.count()).pipe(
          Effect.timeoutOption(TARGET_COUNT_MS),
          Effect.orElseSucceed(Option.none),
        );
        const detail = Option.match(matches, {
          onNone: () => `Whether ${shown} still matches an element is unknown.`,
          onSome: (count) =>
            count === 0
              ? `No element matches ${shown} now; it may have done its work and gone. Take a fresh snapshot.`
              : `${shown} still matches an element.`,
        });
        return yield* new BrowserHostError({
          reason: "timeout",
          detail: `${detail}${error.detail === undefined ? "" : ` ${error.detail}`}`,
        });
      });

    // ---------------------------------------------------------------------
    // Actions

    const typeKeys = Effect.fn("typeKeys")(function* (text: string, deadline: number) {
      let typed = 0;
      // Keys reach pages that build their value from keydown; line breaks stay text,
      // since Enter would submit the form.
      for (const [index, part] of text.split(/([\r\n]+)/u).entries()) {
        const pieces =
          index % 2 === 1 ? [part] : (part.match(new RegExp(`[^]{1,${TYPE_PIECE}}`, "gu")) ?? []);
        for (const piece of pieces) {
          const now = yield* Clock.currentTimeMillis;
          if (now >= deadline)
            return yield* new BrowserHostError({
              reason: "timeout",
              detail: `Typing stopped after ${typed} of ${text.length} characters, which the field now holds. Type the rest in another call.`,
            });
          yield* attempt(() =>
            index % 2 === 1 ? page.keyboard.insertText(piece) : page.keyboard.type(piece),
          );
          typed += piece.length;
        }
      }
    });

    const notTextField = () =>
      new BrowserHostError({
        reason: "not-editable",
        detail: "The target is not an enabled text field, so nothing was typed.",
      });

    const runAction = (
      action: BrowserAction,
      deadline: number,
      pointer: PointerReporter,
    ): Effect.Effect<BrowserActOutcome, BrowserHostError, Scope.Scope> =>
      Effect.gen(function* () {
        switch (action.action) {
          case "click": {
            const target = action.locator === undefined ? undefined : yield* locate(action.locator);
            const point = yield* targetPoint(target, action);
            yield* pointer(point, "click");
            const options = { button: action.button ?? "left", clickCount: action.clickCount ?? 1 };
            const timeout = yield* remaining(deadline);
            const clicked = attempt(() =>
              target === undefined
                ? page.mouse.click(point.x, point.y, options)
                : target.click({ ...options, timeout }),
            );
            yield* target === undefined
              ? clicked
              : clicked.pipe(Effect.catch(namedTimeout(target)));
            return {};
          }
          case "hover": {
            const target = action.locator === undefined ? undefined : yield* locate(action.locator);
            const point = yield* targetPoint(target, action);
            yield* pointer(point, "move");
            const timeout = yield* remaining(deadline);
            yield* attempt(() =>
              target === undefined ? page.mouse.move(point.x, point.y) : target.hover(timeout),
            );
            return {};
          }
          case "type": {
            const target = action.locator === undefined ? undefined : yield* locate(action.locator);
            if (target !== undefined && action.clear === true) {
              const timeout = yield* remaining(deadline);
              if (yield* attempt(() => target.valueOnly())) {
                yield* attempt(() => target.fill(action.text, timeout));
                return {};
              }
              // fill follows a label to its control and leaves it focused for the keys.
              yield* attempt(() => target.fill("", timeout));
              yield* typeKeys(action.text, deadline);
              return {};
            }
            const focused = yield* attempt(() =>
              target === undefined ? page.evaluate(focusTextTarget, null) : target.focusText(),
            );
            if (!focused) return yield* notTextField();
            if (action.clear === true) {
              yield* attempt(() => page.keyboard.press("ControlOrMeta+A"));
              yield* attempt(() => page.keyboard.press("Delete"));
            }
            yield* typeKeys(action.text, deadline);
            return {};
          }
          case "select": {
            const target = yield* locate(action.locator);
            const read: unknown = yield* attempt(() => target.options());
            const options = isOptions(read) ? read : null;
            if (options === null)
              return yield* new BrowserHostError({
                reason: "not-editable",
                detail:
                  "This element is not a <select>. Click a custom dropdown open, then click its option.",
              });
            const values = action.values.map(
              (entry) =>
                (
                  options.find((option) => option.value === entry) ??
                  options.find((option) => option.label === entry.trim())
                )?.value ?? entry,
            );
            const timeout = yield* remaining(deadline);
            const selected = yield* attempt(() => target.selectOption(values, timeout));
            return { selected };
          }
          case "drag": {
            const source = yield* locate(action.source);
            const target = yield* locate(action.target);
            const start = yield* targetPoint(source, {});
            yield* pointer(start, "move");
            const timeout = yield* remaining(deadline);
            yield* attempt(() => source.hover(timeout));
            yield* attempt(() => page.mouse.down());
            const end = yield* targetPoint(target, {});
            yield* attempt(() => page.mouse.move(end.x, end.y, { steps: 5 }));
            yield* attempt(() => page.mouse.up());
            yield* pointer(end, "move");
            return {};
          }
          case "upload": {
            const target = yield* locate(action.locator);
            const timeout = yield* remaining(deadline);
            yield* attempt(() => target.setInputFiles(action.paths, timeout));
            return {};
          }
          case "press": {
            const key = [...(action.modifiers ?? []), action.key].join("+");
            yield* attempt(() => page.keyboard.press(key));
            return {};
          }
          case "scroll": {
            const x = action.deltaX ?? 0;
            const y = action.deltaY ?? 0;
            if (action.locator === undefined) {
              yield* attempt(() => page.evaluate(scrollPage, [x, y] as const));
              return {};
            }
            const target = yield* locate(action.locator);
            yield* attempt(() => target.scrollBy(x, y));
            return {};
          }
        }
      });

    /**
     * One action, within its time. An action that opens a dialog ends there,
     * for the bot to answer it: the page runs nothing until then.
     */
    const act = (
      action: BrowserAction,
      pointer: PointerReporter = noPointer,
    ): Effect.Effect<BrowserActOutcome, BrowserHostError> =>
      Effect.gen(function* () {
        yield* noDialog;
        const timeoutMs =
          ("timeoutMs" in action ? action.timeoutMs : undefined) ?? DEFAULT_BROWSER_TIMEOUT_MS;
        const deadline = yield* deadlineIn(timeoutMs);
        return yield* Effect.raceFirst(
          runAction(action, deadline, pointer).pipe(Effect.scoped),
          dialogOpens.pipe(Effect.as({})),
        ).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs + ACTION_GRACE_MS,
            orElse: () =>
              Effect.fail(
                new BrowserHostError({
                  reason: "timeout",
                  detail: `The ${action.action} ran over ${timeoutMs} ms.`,
                }),
              ),
          }),
        );
      });

    // ---------------------------------------------------------------------
    // Snapshot

    const readFrames = Effect.fn("readFrames")(function* (
      readers: ReadonlyArray<FrameReader>,
      frames: ReadonlyArray<Frame>,
      before?: ReadonlyArray<ReadonlyArray<string> | undefined>,
    ) {
      const now = page.frames();
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i]))
        return yield* new SnapshotPageChanged();
      return yield* Effect.forEach(
        readers,
        (reader, i): Effect.Effect<ReadonlyArray<string> | undefined, SnapshotPageChanged> => {
          const read = Effect.tryPromise({
            try: () => reader.read(),
            catch: () => new SnapshotPageChanged(),
          });
          if (i === 0) return read;
          if (before !== undefined && before[i] === undefined) return Effect.undefined;
          // Another frame that does not answer in time is left unread, and checked below.
          return read.pipe(
            Effect.timeoutOption(FRAME_ANSWER_MS),
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
        },
        { concurrency: "unbounded" },
      );
    });

    const capture = Effect.fn("capture")(function* (includeImage: boolean, deadline: number) {
      const taken = generation;
      const { frames, readers } = yield* Effect.tryPromise({
        try: () => openReaders(page, cdp, frameSessions),
        catch: (cause) => (isFramesChanged(cause) ? new SnapshotPageChanged() : hostErrorOf(cause)),
      });
      const before = yield* readFrames(readers, frames);
      // Leaves time for the second read.
      const treeTimeout = Math.max(1, (yield* remaining(deadline)) - 2_000);
      const tree = yield* refLock.withPermits(1)(
        attempt(() => page.ariaSnapshot({ mode: "ai", boxes: true, timeout: treeTimeout })),
      );
      const after = yield* readFrames(readers, frames, before);
      // A value that changed between the reads may be in the tree under neither.
      if (after.some((values, i) => values !== undefined && !sameValues(values, before[i])))
        return yield* new SnapshotPageChanged();
      const dotted = dottedPattern(after.flatMap((values) => values ?? []));
      if (dotted._tag === "too-long")
        return yield* new BrowserHostError({
          reason: "too-large",
          detail: "A password field holds a value too long to hide, so no snapshot was taken.",
        });
      // A frame left unread can show a value only if its content is in the tree.
      const unread = readers.flatMap((reader, i) => (after[i] === undefined ? reader.frames : []));
      if (unread.length > 0) {
        for (const [, ref] of tree.matchAll(/^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm)) {
          const frame = yield* attempt(async () => {
            const element = await page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
            if (element === null) return undefined;
            const content = await element.contentFrame();
            void element.dispose().catch(() => undefined);
            return content ?? undefined;
          });
          if (frame !== undefined && unread.includes(frame))
            return yield* new BrowserHostError({
              reason: "timeout",
              detail:
                "A frame on the page did not answer, so it could not be checked for hidden values. Take the snapshot again.",
            });
        }
      }
      const page_ = yield* state;
      const image = includeImage ? yield* shoot("png", undefined) : undefined;
      if (generation !== taken) return yield* new SnapshotPageChanged();
      // `data:` payloads go before masking, which could hide the scheme behind a value's dots.
      const redacted = withoutTreeDataPayloads(tree);
      const masked = dotted._tag === "pattern" ? maskTree(redacted, dotted.pattern) : redacted;
      const rewritten = masked.replace(NATIVE_REF, (_match, native: string) => {
        const ref = `j3-${taken}-${native}`;
        refs.set(ref, native);
        return `[ref=${ref}]`;
      });
      const truncated = rewritten.length > MAX_BROWSER_SNAPSHOT_LENGTH;
      const cut = truncated ? cutTree(rewritten) : rewritten;
      return {
        ...page_,
        title: dotted._tag === "pattern" ? maskText(page_.title, dotted.pattern) : page_.title,
        tree: cut,
        truncated,
        ...(image === undefined ? {} : { image }),
      };
    });

    const snapshot = Effect.fn("snapshot")(function* (options: { readonly includeImage: boolean }) {
      yield* noDialog;
      const deadline = yield* deadlineIn(SNAPSHOT_TIMEOUT_MS);
      const once = capture(options.includeImage, deadline);
      // A page that changed while it was read is read once more, within the same time.
      return yield* once.pipe(
        Effect.catchTag("SnapshotPageChanged", () =>
          once.pipe(Effect.catchTag("SnapshotPageChanged", () => Effect.fail(pageChanged()))),
        ),
        Effect.timeoutOrElse({
          duration: SNAPSHOT_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new BrowserHostError({
                reason: "timeout",
                detail: `The snapshot took over ${SNAPSHOT_TIMEOUT_MS / 1000} seconds. Try it again.`,
              }),
            ),
        }),
      );
    });

    // ---------------------------------------------------------------------
    // Pictures

    const shoot = Effect.fn("shoot")(function* (
      format: "png" | "jpeg",
      quality: number | undefined,
    ) {
      const size = yield* viewport;
      const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (size.width * size.ratio));
      const { data } = yield* attempt(() =>
        cdp.send("Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: quality ?? 80 } : {}),
          clip: { x: 0, y: 0, width: size.width, height: size.height, scale },
        }),
      );
      const measured = imageSize(format, data);
      return {
        mimeType: format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
        data,
        width: measured?.width ?? Math.round(size.width * size.ratio * scale),
        height: measured?.height ?? Math.round(size.height * size.ratio * scale),
      };
    });

    let screencastFrame = 0;
    /** The frame the subscriber holds, and the newest one waiting behind it. */
    let delivered: { readonly frame: number; readonly session: number } | undefined;
    let waiting: { readonly session: number; readonly value: BrowserScreencastFrame } | undefined;
    let screencastQueue:
      | Queue.Queue<BrowserScreencastFrame, BrowserHostError | Cause.Done>
      | undefined;

    const deliver = (session: number, value: BrowserScreencastFrame) => {
      if (screencastQueue === undefined) return;
      delivered = { frame: value.frame, session };
      Queue.offerUnsafe(screencastQueue, value);
    };

    const screencast = (options: {
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
    }) =>
      Stream.callback<BrowserScreencastFrame, BrowserHostError>((queue) =>
        Effect.gen(function* () {
          if (screencastQueue !== undefined)
            return yield* new BrowserHostError({
              reason: "refused",
              detail: "This tab is already being watched; its one screencast is shared.",
            });
          screencastQueue = queue;
          delivered = undefined;
          waiting = undefined;
          const onFrame = (event: {
            readonly data: string;
            readonly sessionId: number;
            readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number };
          }) => {
            const jpeg = Base64.decode(event.data);
            if (Result.isFailure(jpeg)) {
              void cdp
                .send("Page.screencastFrameAck", { sessionId: event.sessionId })
                .catch(() => undefined);
              return;
            }
            const value: BrowserScreencastFrame = {
              frame: ++screencastFrame,
              jpeg: jpeg.success,
              viewport: {
                width: Math.round(event.metadata.deviceWidth),
                height: Math.round(event.metadata.deviceHeight),
              },
            };
            if (delivered === undefined) {
              deliver(event.sessionId, value);
              return;
            }
            // Only the newest waits: the one it replaces is let go at once.
            if (waiting !== undefined)
              void cdp
                .send("Page.screencastFrameAck", { sessionId: waiting.session })
                .catch(() => undefined);
            waiting = { session: event.sessionId, value };
          };
          cdp.on("Page.screencastFrame", onFrame);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              cdp.off("Page.screencastFrame", onFrame);
              screencastQueue = undefined;
              delivered = undefined;
              waiting = undefined;
              yield* attempt(() => cdp.send("Page.stopScreencast")).pipe(Effect.ignore);
            }),
          );
          yield* attempt(() =>
            cdp.send("Page.startScreencast", {
              format: "jpeg",
              quality: options.quality,
              maxWidth: options.maxWidth,
              maxHeight: options.maxHeight,
            }),
          );
        }),
      );

    const screencastAck = Effect.fn("screencastAck")(function* (frame: number) {
      if (delivered === undefined || delivered.frame !== frame) return;
      const session = delivered.session;
      delivered = undefined;
      yield* attempt(() => cdp.send("Page.screencastFrameAck", { sessionId: session })).pipe(
        Effect.ignore,
      );
      const next = waiting;
      waiting = undefined;
      if (next !== undefined) deliver(next.session, next.value);
    });

    // ---------------------------------------------------------------------
    // The rest

    const evaluate = Effect.fn("evaluate")(function* (input: {
      readonly expression: string;
      readonly awaitPromise: boolean;
      readonly timeoutMs?: number | undefined;
    }) {
      yield* noDialog;
      const timeoutMs = input.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
      const params = {
        expression: input.expression,
        awaitPromise: input.awaitPromise,
        returnByValue: true,
      };
      const run = attempt(async () => {
        const classic = await cdp.send("Runtime.evaluate", params);
        const failure = classic.exceptionDetails;
        // The console's replMode allows top-level await; it is tried only for what the parser
        // refused: a parse error has a scriptId and no stack, and ran nothing.
        const unparsed =
          failure?.exception?.className === "SyntaxError" &&
          failure.scriptId !== undefined &&
          failure.stackTrace === undefined;
        return unparsed && input.expression.includes("await")
          ? cdp.send("Runtime.evaluate", { ...params, replMode: true })
          : classic;
      });
      const result = yield* run.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            terminate.pipe(
              Effect.andThen(
                Effect.fail(
                  new BrowserHostError({
                    reason: "timeout",
                    detail: `The script ran over ${timeoutMs} ms and was stopped.`,
                  }),
                ),
              ),
            ),
        }),
      );
      if (result.exceptionDetails !== undefined)
        return yield* new BrowserHostError({
          reason: "page",
          detail: (
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
          ).slice(0, 500),
        });
      const raw: unknown =
        "value" in result.result ? result.result.value : (result.result.description ?? null);
      const value = yield* decodeJson(raw ?? null).pipe(
        Effect.orElseSucceed(() => result.result.description ?? null),
      );
      const bytes = jsonBytes(value);
      if (bytes > MAX_BROWSER_EVALUATE_RESULT_BYTES)
        return yield* new BrowserHostError({
          reason: "too-large",
          detail: `It is ${bytes} bytes; the most is ${MAX_BROWSER_EVALUATE_RESULT_BYTES}.`,
        });
      return { value };
    });

    const waitFor = (condition: BrowserWaitCondition) => waitScoped(condition).pipe(Effect.scoped);
    const waitScoped = Effect.fn("waitFor")(function* (condition: BrowserWaitCondition) {
      yield* noDialog;
      const timeoutMs = condition.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
      const target = condition.locator === undefined ? undefined : yield* locate(condition.locator);
      const { text, urlIncludes } = condition;
      const holds = Effect.gen(function* () {
        if (target !== undefined && (yield* attempt(() => target.count())) === 0) return false;
        if (text !== undefined) {
          // A navigation can destroy the context mid-check; that counts as not yet.
          const found = yield* attempt(() => page.evaluate(pageHasText, text)).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (found !== true) return false;
        }
        return urlIncludes === undefined || page.url().includes(urlIncludes);
      });
      const poll: Effect.Effect<void, BrowserHostError> = Effect.gen(function* () {
        while (!(yield* holds)) yield* Effect.sleep(WAIT_POLL_MS);
      });
      yield* poll.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new BrowserHostError({
                reason: "timeout",
                detail: `Waited ${timeoutMs} ms and not every condition held.`,
              }),
            ),
        }),
      );
    });

    /**
     * Stops a script that keeps the page from answering. A renderer blocked
     * on something else may never acknowledge the stop, so it is not awaited.
     */
    const terminate = Effect.sync(() => {
      void cdp.send("Runtime.terminateExecution").catch(() => undefined);
    });
    const stopStuckScript = Effect.fn("stopStuckScript")(function* (deadline: number) {
      const budget = Math.min(UNRESPONSIVE_SCRIPT_MS, (yield* remaining(deadline)) / 2);
      const answered = yield* attempt(() => cdp.send("Runtime.evaluate", { expression: "0" })).pipe(
        Effect.ignore,
        Effect.timeoutOption(budget),
      );
      if (Option.isNone(answered)) yield* terminate;
    });

    const navigate = Effect.fn("navigate")(function* (
      to: BrowserNavigation,
      options: {
        readonly readiness?: BrowserReadiness | undefined;
        readonly timeoutMs?: number | undefined;
      },
    ) {
      const deadline = yield* deadlineIn(options.timeoutMs);
      const readiness = options.readiness ?? "load";
      const address = to.kind === "url" ? addressOf(to.url) : undefined;
      if (to.kind === "url" && address === undefined)
        return yield* new BrowserHostError({
          reason: "refused",
          detail: "Only http and https addresses open.",
        });
      // A page stuck in a script would hold the navigation until it times out.
      if (dialog === undefined) yield* stopStuckScript(deadline);
      const go = { waitUntil: "commit" as const, timeout: yield* remaining(deadline) };
      const committed = attempt((): Promise<unknown> => {
        switch (to.kind) {
          case "url":
            return page.goto(address ?? to.url, go);
          case "back":
            return page.goBack(go);
          case "forward":
            return page.goForward(go);
          case "reload":
            return page.reload(go);
        }
      });
      const failed = yield* committed.pipe(
        Effect.as(false),
        // A page that failed to load shows the browser's error page, which `loadError` names.
        Effect.catchIf(
          (error) => error.reason === "page" && /net::ERR_/.test(error.detail ?? ""),
          () => Effect.succeed(true),
        ),
      );
      if (failed) {
        // The error page commits after the failure; a navigation started before it would be cut off.
        const timeout = Math.min(2_000, yield* remaining(deadline));
        yield* attempt(() =>
          page.waitForURL((url) => url.protocol === "chrome-error:", {
            waitUntil: "commit",
            timeout,
          }),
        ).pipe(Effect.ignore);
      } else if (readiness !== "none") {
        // Once the page commits, a slow subresource only delays readiness: the page is reported loading.
        const timeout = yield* remaining(deadline);
        yield* attempt(() =>
          page.waitForLoadState(readiness === "load" ? "load" : "domcontentloaded", { timeout }),
        ).pipe(Effect.catchIf(isTimeoutError, () => Effect.void));
      }
      return yield* state;
    });

    const answerDialog = Effect.fn("answerDialog")(function* (
      accept: boolean,
      promptText?: string,
    ) {
      const open = dialog;
      if (open === undefined)
        return yield* new BrowserHostError({
          reason: "invalid-target",
          detail: "No dialog is open.",
        });
      dialog = undefined;
      yield* attempt(() => (accept ? open.accept(promptText) : open.dismiss()));
    });

    const MOUSE_TYPE = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

    const input = (given: BrowserPageInput) =>
      attempt(async () => {
        switch (given.type) {
          case "pointer":
            await cdp.send("Input.dispatchMouseEvent", {
              type: MOUSE_TYPE[given.action],
              x: given.x,
              y: given.y,
              button: given.button,
              buttons: given.buttons,
              clickCount: given.clickCount,
              modifiers: given.modifiers,
            });
            return;
          case "wheel":
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: given.x,
              y: given.y,
              deltaX: given.deltaX,
              deltaY: given.deltaY,
              modifiers: given.modifiers,
            });
            return;
          case "key":
            await cdp.send("Input.dispatchKeyEvent", {
              type:
                given.action === "up"
                  ? "keyUp"
                  : given.text === undefined
                    ? "rawKeyDown"
                    : "keyDown",
              key: given.key,
              code: given.code,
              modifiers: given.modifiers,
              ...(given.text === undefined ? {} : { text: given.text }),
              ...(given.keyCode === undefined ? {} : { windowsVirtualKeyCode: given.keyCode }),
            });
            return;
          case "text":
            await cdp.send("Input.insertText", { text: given.text });
            return;
        }
      });

    const probe = (x: number, y: number) =>
      attempt(() => page.evaluate(editableAt, [x, y] as const)).pipe(
        Effect.map((editable) => editable === true),
      );

    return {
      tab,
      page,
      state,
      changes,
      snapshot,
      act,
      evaluate,
      waitFor,
      navigate,
      answerDialog,
      screenshot: (options) => shoot(options.format, options.quality),
      input,
      probe,
      screencast,
      screencastAck,
    } satisfies DriverPage;
  });

/** The tree cut to its limit, at a line's end where one is in reach, never inside a character. */
const cutTree = (tree: string) => {
  const lineEnd = tree.lastIndexOf("\n", MAX_BROWSER_SNAPSHOT_LENGTH);
  const end = lineEnd > 0 ? lineEnd : MAX_BROWSER_SNAPSHOT_LENGTH;
  const last = tree.charCodeAt(end - 1);
  return tree.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
};

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string> | undefined) =>
  b !== undefined && a.length === b.length && a.every((value, i) => value === b[i]);
