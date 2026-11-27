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
import * as Stream from "effect/Stream";
import type { CDPSession, Dialog, Frame, Locator, Page, Request } from "playwright-core";
import { addressOf } from "./address.ts";
import { hostErrorOf } from "./errors.ts";
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
   * The page after each change of address, title, loading or dialog, until
   * the page closes. One subscriber at a time.
   */
  readonly changes: Stream.Stream<BrowserPageState>;
  /**
   * The page as a bot reads it, with fresh refs that replace the earlier
   * ones. Hidden values are masked.
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
   * stream at a time.
   */
  readonly screencast: (options: {
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  }) => Stream.Stream<BrowserScreencastFrame, BrowserHostError>;
  readonly screencastAck: (frame: number) => Effect.Effect<void>;
  /** Revokes every ref the page gave out, as when a person takes the tab. */
  readonly forgetRefs: Effect.Effect<void>;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;
const FRAME_ANSWER_MS = 1_000;
const TARGET_COUNT_MS = 250;
const WAIT_POLL_MS = 100;
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
export const parseNetError = (errorText: string) => {
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

const DOCUMENT_SCRIPT = `({ title: document.title, loading: document.readyState !== "complete" })`;
const VIEWPORT_SCRIPT = `({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })`;

// Run in the page's main world: they must not reference module scope.
const FOCUS_SCRIPT = `(target) => {
  let element = target ?? document.activeElement;
  if (target == null) {
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    // Focus inside a frame cannot be checked from here, and an editable frame would pass as editable.
    if (element && ["IFRAME", "FRAME", "FENCEDFRAME", "OBJECT", "EMBED"].includes(element.tagName)) return false;
  }
  if (element == null) return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const textControl = element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && !nonText.includes(element.type ?? "text"));
  if (!(textControl || element.isContentEditable) || element.disabled || element.readOnly) return false;
  element.focus?.();
  const active = element.getRootNode().activeElement;
  return active != null && (active === element || element.contains(active));
}`;

// Pickers and sliders take a value such as 2026-01-31 only from fill.
const VALUE_ONLY_SCRIPT = `(target) => {
  const element = target.tagName === "INPUT" ? target : target.closest("label")?.control;
  return element?.tagName === "INPUT" && ["color", "date", "datetime-local", "month", "range", "time", "week"].includes(element.type ?? "");
}`;

const SELECT_OPTIONS_SCRIPT = `(element) => element.tagName === "SELECT"
  ? Array.from(element.options, ({ value, label }) => ({ value, label: label.trim() }))
  : null`;

const PROBE_SCRIPT = `([x, y]) => {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (inner == null || inner === element) break;
    element = inner;
  }
  if (element == null) return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const field = element.closest("input, textarea, [contenteditable]") ?? element;
  if (field.isContentEditable) return true;
  if (field.tagName === "TEXTAREA") return !field.disabled && !field.readOnly;
  return field.tagName === "INPUT" && !nonText.includes(field.type ?? "text") && !field.disabled && !field.readOnly;
}`;

const TEXT_SCRIPT = `(text) => (document.body?.innerText ?? "").includes(text)`;
const SCROLL_PAGE_SCRIPT = `([x, y]) => scrollBy(x, y)`;
const SCROLL_ELEMENT_SCRIPT = `(element, [x, y]) => element.scrollBy(x, y)`;

const WAIT_UNTIL: Record<BrowserReadiness, "load" | "domcontentloaded" | "commit"> = {
  load: "load",
  domContentLoaded: "domcontentloaded",
  none: "commit",
};

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

    // Refs carry a namespace of this driver and a count of its snapshots, so a ref from
    // another tab, an earlier page or before a restart never names an element here.
    const namespace = (yield* Random.nextIntBetween(0, 0x7fffffff)).toString(36);
    let sequence = 0;
    let generation = "";
    const refs = new Map<string, string>();
    const forget = () => {
      generation = `${namespace}-${(++sequence).toString(36)}`;
      refs.clear();
    };
    forget();

    let dialog: Dialog | undefined;
    let loadError: BrowserLoadError | null = null;
    const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

    const onFrameNavigated = (frame: Frame) => {
      if (frame === page.mainFrame()) forget();
    };
    const onFrameDetached = () => forget();
    const onDialog = (opened: Dialog) => {
      dialog = opened;
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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
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
          ? yield* attempt(() => page.evaluate(DOCUMENT_SCRIPT)).pipe(
              Effect.timeoutOption(1_000),
              Effect.map(Option.filter(isDocumentState)),
              Effect.orElseSucceed(Option.none),
            )
          : Option.none();
      return {
        tab,
        url: url === "about:blank" ? "" : withoutDataPayload(url),
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
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            page.off("framenavigated", onNavigated);
            page.off("domcontentloaded", changed);
            page.off("load", changed);
            page.off("dialog", changed);
            page.off("requestfailed", changed);
            page.off("close", onClose);
          }),
        );
      }),
    ).pipe(Stream.mapEffect(() => state));

    // ---------------------------------------------------------------------
    // Locating

    /**
     * The locator a target names. A ref must be one the latest snapshot gave
     * out and the page has not changed since; anything else is refused as
     * stale rather than letting it name another element.
     */
    const locate = (target: string): Effect.Effect<Locator, BrowserHostError> => {
      const engines = target.replace(
        /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
        " ",
      );
      if (!/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) return Effect.succeed(page.locator(target));
      const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(target)?.[1];
      const native = ref === undefined ? undefined : refs.get(ref);
      return native === undefined
        ? Effect.fail(new BrowserHostError({ reason: "stale-ref" }))
        : Effect.succeed(page.locator(`aria-ref=${native}`));
    };

    const deadlineIn = (timeoutMs: number | undefined) =>
      Effect.map(Clock.currentTimeMillis, (now) => now + (timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS));
    const remaining = (deadline: number) =>
      Effect.map(Clock.currentTimeMillis, (now) => Math.max(1, deadline - now));

    const viewport = Effect.gen(function* () {
      const read: unknown = yield* attempt(() => page.evaluate(VIEWPORT_SCRIPT));
      return isViewport(read) ? read : { width: 1280, height: 800, ratio: 1 };
    });

    const targetPoint = Effect.fn("targetPoint")(function* (
      locator: Locator | undefined,
      at: { readonly x?: number | undefined; readonly y?: number | undefined },
    ) {
      if (locator === undefined) return { x: at.x ?? 0, y: at.y ?? 0 };
      yield* attempt(async () => {
        // A page that replaces the node mid-scroll fails it; the input after it resolves again.
        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
      });
      const box = yield* attempt(async () => locator.boundingBox({ timeout: 2_000 })).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (box !== null) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const size = yield* viewport;
      return { x: size.width / 2, y: size.height / 2 };
    });

    /** The page's dialog opening: a click that opens one does not end until it is answered. */
    const dialogOpens = Effect.callback<void>((resume) => {
      const opened = () => resume(Effect.void);
      page.once("dialog", opened);
      return Effect.sync(() => page.off("dialog", opened));
    });

    /**
     * Playwright's timeout names neither the target nor why it waited. The
     * click may still have happened, so the bot is told to look first.
     */
    const namedTimeout = (locator: Locator, target: string) => (error: BrowserHostError) =>
      Effect.gen(function* () {
        if (!isTimeoutError(error)) return yield* error;
        const quoted = `"${target}"`;
        const shown =
          quoted.length > MAX_TARGET_CHARS ? `${quoted.slice(0, MAX_TARGET_CHARS)}...` : quoted;
        const matches = yield* attempt(() => locator.count()).pipe(
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

    const act = (
      action: BrowserAction,
      pointer: PointerReporter = noPointer,
    ): Effect.Effect<BrowserActOutcome, BrowserHostError> =>
      Effect.gen(function* () {
        switch (action.action) {
          case "click": {
            const deadline = yield* deadlineIn(action.timeoutMs);
            const locator =
              action.locator === undefined ? undefined : yield* locate(action.locator);
            const run = Effect.gen(function* () {
              const point = yield* targetPoint(locator, action);
              yield* pointer(point, "click");
              const options = {
                button: action.button ?? "left",
                clickCount: action.clickCount ?? 1,
              };
              const timeout = yield* remaining(deadline);
              const clicked = attempt(() =>
                locator === undefined
                  ? page.mouse.click(point.x, point.y, options)
                  : locator.click({ ...options, timeout }),
              );
              yield* Effect.raceFirst(clicked, dialogOpens);
            });
            yield* locator === undefined || action.locator === undefined
              ? run
              : run.pipe(Effect.catch(namedTimeout(locator, action.locator)));
            return {};
          }
          case "hover": {
            const deadline = yield* deadlineIn(action.timeoutMs);
            const locator =
              action.locator === undefined ? undefined : yield* locate(action.locator);
            const point = yield* targetPoint(locator, action);
            yield* pointer(point, "move");
            const timeout = yield* remaining(deadline);
            yield* attempt(() =>
              locator === undefined
                ? page.mouse.move(point.x, point.y)
                : locator.hover({ timeout }),
            );
            return {};
          }
          case "type": {
            const deadline = yield* deadlineIn(action.timeoutMs);
            const locator =
              action.locator === undefined ? undefined : yield* locate(action.locator);
            if (locator !== undefined && action.clear === true) {
              const timeout = yield* remaining(deadline);
              const valueOnly = yield* attempt(() =>
                locator.evaluate(VALUE_ONLY_SCRIPT, undefined, { timeout }),
              );
              if (valueOnly === true) {
                yield* attempt(() => locator.fill(action.text, { timeout }));
                return {};
              }
              // fill follows a label to its control and leaves it focused for the keys.
              yield* attempt(() => locator.fill("", { timeout }));
              yield* typeKeys(action.text, deadline);
              return {};
            }
            const timeout = yield* remaining(deadline);
            const focused = yield* locator === undefined
              ? attempt(() => page.evaluate(FOCUS_SCRIPT, null)).pipe(
                  Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () => Effect.succeed(false),
                  }),
                )
              : attempt(() => locator.evaluate(FOCUS_SCRIPT, undefined, { timeout }));
            if (focused !== true) return yield* notTextField();
            if (action.clear === true) {
              yield* attempt(() => page.keyboard.press("ControlOrMeta+A"));
              yield* attempt(() => page.keyboard.press("Delete"));
            }
            yield* typeKeys(action.text, deadline);
            return {};
          }
          case "select": {
            const locator = yield* locate(action.locator);
            const timeout = action.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
            const read: unknown = yield* attempt(() =>
              locator.evaluate(SELECT_OPTIONS_SCRIPT, undefined, { timeout }),
            );
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
            const selected = yield* attempt(() => locator.selectOption(values, { timeout }));
            return { selected };
          }
          case "drag": {
            const deadline = yield* deadlineIn(action.timeoutMs);
            const source = yield* locate(action.source);
            const target = yield* locate(action.target);
            yield* pointer(yield* targetPoint(source, {}), "move");
            const timeout = yield* remaining(deadline);
            yield* attempt(() => source.dragTo(target, { timeout, steps: 5 }));
            const end = yield* attempt(() => target.boundingBox({ timeout: 1_000 })).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (end !== null)
              yield* pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
            return {};
          }
          case "upload": {
            const locator = yield* locate(action.locator);
            const timeout = action.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
            yield* attempt(() => locator.setInputFiles([...action.paths], { timeout }));
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
              yield* attempt(() => page.evaluate(SCROLL_PAGE_SCRIPT, [x, y]));
              return {};
            }
            const locator = yield* locate(action.locator);
            yield* attempt(() =>
              locator.evaluate(SCROLL_ELEMENT_SCRIPT, [x, y], {
                timeout: DEFAULT_BROWSER_TIMEOUT_MS,
              }),
            );
            return {};
          }
        }
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
      forget();
      const taken = generation;
      const { frames, readers } = yield* Effect.tryPromise({
        try: () => openReaders(page, cdp, frameSessions),
        catch: (cause) => (isFramesChanged(cause) ? new SnapshotPageChanged() : hostErrorOf(cause)),
      });
      const before = yield* readFrames(readers, frames);
      // Leaves time for the second read.
      const treeTimeout = Math.max(1, (yield* remaining(deadline)) - 2_000);
      const tree = yield* attempt(() =>
        page.ariaSnapshot({ mode: "ai", boxes: true, timeout: treeTimeout }),
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
      const cut = truncated
        ? rewritten.slice(0, rewritten.lastIndexOf("\n", MAX_BROWSER_SNAPSHOT_LENGTH))
        : rewritten;
      return {
        ...page_,
        title: dotted._tag === "pattern" ? maskText(page_.title, dotted.pattern) : page_.title,
        tree: cut,
        truncated,
        ...(image === undefined ? {} : { image }),
      };
    });

    const snapshot = Effect.fn("snapshot")(function* (options: { readonly includeImage: boolean }) {
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
            attempt(() => cdp.send("Runtime.terminateExecution")).pipe(
              Effect.ignore,
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

    const waitFor = Effect.fn("waitFor")(function* (condition: BrowserWaitCondition) {
      const timeoutMs = condition.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
      const locator =
        condition.locator === undefined ? undefined : yield* locate(condition.locator);
      const { text, urlIncludes } = condition;
      const holds = Effect.gen(function* () {
        if (locator !== undefined && (yield* attempt(() => locator.count())) === 0) return false;
        if (text !== undefined) {
          // A navigation can destroy the context mid-check; that counts as not yet.
          const found = yield* attempt(() => page.evaluate(TEXT_SCRIPT, text)).pipe(
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

    const navigate = Effect.fn("navigate")(function* (
      to: BrowserNavigation,
      options: {
        readonly readiness?: BrowserReadiness | undefined;
        readonly timeoutMs?: number | undefined;
      },
    ) {
      const go = {
        waitUntil: WAIT_UNTIL[options.readiness ?? "load"],
        timeout: options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
      };
      const address = to.kind === "url" ? addressOf(to.url) : undefined;
      if (to.kind === "url" && address === undefined)
        return yield* new BrowserHostError({
          reason: "refused",
          detail: "Only http and https addresses open.",
        });
      const run = (): Promise<unknown> => {
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
      };
      yield* attempt(run).pipe(
        // A page that failed to load shows the browser's error page, which `loadError` names.
        Effect.catchIf(
          (error) => error.reason === "page" && /net::ERR_/.test(error.detail ?? ""),
          () => Effect.void,
        ),
      );
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
      attempt(() => page.evaluate(PROBE_SCRIPT, [x, y])).pipe(
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
      forgetRefs: Effect.sync(forget),
    } satisfies DriverPage;
  });

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string> | undefined) =>
  b !== undefined && a.length === b.length && a.every((value, i) => value === b[i]);
