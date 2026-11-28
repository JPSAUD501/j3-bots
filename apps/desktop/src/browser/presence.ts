// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserHostError } from "@j3-bots/contracts";
import { PRESENCE_GLOBAL, PresenceCall, type PresenceBot } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { WebContents } from "electron";

// The bots' pointers in the pages of the desktop's browser (docs/architecture/browser.md,
// "Presence in the page"): the web client's drawing (apps/web/src/browser/desktop/presence),
// run in a world of the tab's page that is neither the page's nor Electron's, while the
// tab is on the person's screen and a bot is on it.

/** The page's world is 0 and Electron's own is 999: the drawing's is apart from both. */
const PRESENCE_WORLD = 1_710;
/** How long a call to the drawing may take: a page held by a dialog runs no script until it is answered. */
const CALL_MS = 1_000;

const encodeCall = Schema.encodeSync(PresenceCall);

/** The script of a call: false when the world has no drawing yet. */
const callScript = (call: PresenceCall) =>
  `(() => {
    const drawing = globalThis[${JSON.stringify(PRESENCE_GLOBAL)}];
    if (typeof drawing !== "function") return false;
    drawing(JSON.parse(${JSON.stringify(JSON.stringify(encodeCall(call)))}));
    return true;
  })()`;

/** Where a bot points on the tab, as the host hears it. */
interface PagePointer {
  readonly action: "move" | "click";
  readonly x: number;
  readonly y: number;
}

/** The tab's bots, most recent first, and whether the person holds it. */
type Presence = { readonly bots: ReadonlyArray<PresenceBot>; readonly held: boolean };
type PointCall = Extract<PresenceCall, { readonly _tag: "point" }>;

/** A tab's page, as it shows the bots on the tab. */
export interface TabDrawing {
  /** Who is on the tab: null with no bot on it. */
  readonly onTab: (presence: Presence | null) => Effect.Effect<void>;
  /** Whether the tab is on the person's screen. */
  readonly shown: (shown: boolean) => Effect.Effect<void>;
  readonly point: (pointer: PagePointer) => Effect.Effect<void>;
  /** Nothing drawn for as long as the scope lives: a bot reads the page, never its own pointer. */
  readonly hidden: Effect.Effect<void, never, Scope.Scope>;
  /** The tab went to a new document: its world is new, with nothing drawn. */
  readonly navigated: Effect.Effect<void>;
}

const NOTHING: PresenceCall = { _tag: "draw", bots: [], held: false, hidden: false };
/** A call as the page last took it, to tell whether the next one changes anything. */
const keyOf = (call: PresenceCall) => JSON.stringify(encodeCall(call));

/**
 * The drawing of `contents`' page, from `script`, the drawing's bundle:
 * null where the app carries none, and then nothing is drawn. Nothing runs
 * in a page until a bot is on its tab while it shows.
 */
export const makeTabDrawing = Effect.fn("makeTabDrawing")(function* (
  contents: WebContents,
  script: Effect.Effect<string | null>,
) {
  const turns = yield* Semaphore.make(1);
  let presence: Presence | null = null;
  let shown = false;
  let capturing = 0;
  let sequence = 0;
  /** Where the tab's bot last pointed on this document: a drawing begun later shows it there. */
  let last: PointCall | null = null;
  /** Whether this document's world may hold a drawing: one never drawn in is left untouched. */
  let touched = false;
  /** What the page draws now, as last told: null once a call went unanswered. */
  let drawn: string | null = keyOf(NOTHING);
  const drawing = () => drawn !== null && drawn !== keyOf(NOTHING);

  const run = (code: string) =>
    Effect.tryPromise({
      try: (): Promise<unknown> =>
        contents.executeJavaScriptInIsolatedWorld(PRESENCE_WORLD, [{ code }]),
      catch: (cause) =>
        new BrowserHostError({ reason: "page", detail: String(cause).slice(0, 500) }),
    });

  /** Hands `call` to the page's drawing, running the drawing first where a bot is to be drawn. */
  const send = Effect.fn("TabDrawing.send")(
    function* (call: PresenceCall) {
      if (contents.isDestroyed()) return false;
      if ((yield* run(callScript(call))) === true) return true;
      // A world with no drawing has nothing to take away.
      if (call._tag === "draw" && call.bots.length === 0) return true;
      const bundle = yield* script;
      if (bundle === null) return false;
      yield* run(bundle);
      return (yield* run(callScript(call))) === true;
    },
    Effect.timeoutOption(CALL_MS),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catch((cause) =>
      Effect.as(Effect.logDebug("A tab's page did not take the bots' pointers", cause), false),
    ),
  );

  /** Tells the page what it should draw now, if that changed. */
  const sync = Effect.gen(function* () {
    const wanted: PresenceCall =
      presence !== null && presence.bots.length > 0 && shown
        ? { _tag: "draw", bots: presence.bots, held: presence.held, hidden: capturing > 0 }
        : NOTHING;
    const key = keyOf(wanted);
    if (key === drawn) return;
    if (wanted === NOTHING && !touched) {
      drawn = key;
      return;
    }
    touched = true;
    const was = drawing();
    drawn = (yield* send(wanted)) ? key : null;
    // A drawing begun shows the bot where it last pointed, without clicking there again.
    if (!was && drawing() && last !== null && !(yield* send({ ...last, action: "move" }))) {
      drawn = null;
    }
  });

  const inTurn = (change: () => void) =>
    turns.withPermits(1)(
      Effect.suspend(() => {
        change();
        return sync;
      }),
    );

  const tabDrawing: TabDrawing = {
    onTab: (now) =>
      inTurn(() => {
        presence = now;
      }),
    shown: (now) =>
      inTurn(() => {
        shown = now;
      }),
    point: ({ action, x, y }) =>
      turns.withPermits(1)(
        Effect.gen(function* () {
          // A drawing a call left unsure of is drawn again first.
          yield* sync;
          sequence += 1;
          const now: PointCall = { _tag: "point", action, x, y, sequence };
          last = now;
          if (drawing() && !(yield* send(now))) drawn = null;
        }),
      ),
    hidden: Effect.acquireRelease(
      inTurn(() => {
        capturing += 1;
      }),
      () =>
        inTurn(() => {
          capturing -= 1;
        }),
    ),
    navigated: inTurn(() => {
      drawn = keyOf(NOTHING);
      touched = false;
      last = null;
    }),
  };
  return tabDrawing;
});
