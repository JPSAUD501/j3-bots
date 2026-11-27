// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, DeviceId, MAX_ID_LENGTH, NonNegativeInt } from "./base.ts";

// J3 Bots' browser (decision 0110): tabs J3 Bots runs itself, on a desktop
// app's own browser or on the server's, shared by the person and every bot
// that may browse. A client follows one bot's tabs on the RPC socket
// (`browser.subscribe`), and watches and drives one on the media socket
// (`HTTP_PATHS.browser`). `SharedBrowserTabs` is the shape of the list of
// every tab, which no call serves yet. A page host speaks `browserHost.ts`;
// a bot reaches the tabs through the `browser_*` tools (`browserTools.ts`).

/**
 * One tab, as J3 Bots names it everywhere: to clients, to page hosts and to
 * bots. Opaque.
 */
export const BrowserTabRef = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ID_LENGTH),
).pipe(Schema.brand("BrowserTabRef"));
export type BrowserTabRef = typeof BrowserTabRef.Type;

/**
 * Who acts on a tab, as the reader of the value sees it.
 *
 * - `bot`: a bot may act on it; no person holds it.
 * - `you`: on the tab list, this device; on the media socket, this socket.
 * - `another-device`: a person on another device, or on another socket of
 *   this one, holds it. Bots cannot act on the tab meanwhile.
 * - `nobody`: no bot and no person.
 */
export const BrowserController = Schema.Literals(["bot", "you", "another-device", "nobody"]);
export type BrowserController = typeof BrowserController.Type;

export const BrowserDialogKind = Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]);
export type BrowserDialogKind = typeof BrowserDialogKind.Type;

/** A dialog the page waits on: it blocks the page until someone answers it. */
export const BrowserDialog = Schema.Struct({
  kind: BrowserDialogKind,
  message: Schema.String,
  defaultValue: Schema.String,
});
export type BrowserDialog = typeof BrowserDialog.Type;

/**
 * Where a tab runs now.
 *
 * - `desktop`: in the J3 Bots app on that computer, in its own browser.
 * - `server`: in the server's own browser.
 * - `parked`: its host went away (the app closed, or the server's browser
 *   let an idle tab go). It keeps its address and title, and the next bot
 *   that uses it opens it again where a new tab opens: in the app the person
 *   used last, else on the server.
 */
export const BrowserTabWhere = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("desktop"), device: DeviceId }),
  Schema.Struct({ kind: Schema.Literal("server") }),
  Schema.Struct({ kind: Schema.Literal("parked") }),
]);
export type BrowserTabWhere = typeof BrowserTabWhere.Type;

/**
 * Who opened a tab: the person on a device, a bot, or a page, as a sign-in
 * opens a pop-up. A pop-up stays on the host of the tab that opened it,
 * since the page needs its opener.
 */
export const BrowserTabOpener = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), device: DeviceId }),
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
  Schema.Struct({ kind: Schema.Literal("page"), tab: BrowserTabRef }),
]);
export type BrowserTabOpener = typeof BrowserTabOpener.Type;

/**
 * Who holds a tab, so that nobody else acts on it.
 *
 * - `person`: the person used the page from `device`: a click, a key or a
 *   scroll on it, in the app or through a viewer. Moving the pointer,
 *   scrolling the view, finding in the page and zooming do not count. The
 *   hold ends by itself at `until`, 10 seconds after their last input; it
 *   is null while they asked the bots to wait for them, until they say to
 *   go on. Bots' actions fail meanwhile; reading the page still works.
 * - `bot`: a bot's lease. It acts in turn, and others' actions wait behind
 *   it. It lapses at `until`, 5 seconds after its last action ends, or
 *   when its turn ends.
 * - `fill`: the server is typing a saved login.
 */
export const BrowserTabHolder = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    device: DeviceId,
    until: Schema.NullOr(Schema.DateTimeUtc),
  }),
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId, until: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("fill") }),
]);
export type BrowserTabHolder = typeof BrowserTabHolder.Type;

/** The fields every view of a tab shares. */
const sharedTabFields = {
  ref: BrowserTabRef,
  /** Empty for a tab that has not loaded a page yet. */
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  where: BrowserTabWhere,
  openedBy: BrowserTabOpener,
  /** The bots that used the tab recently, the most recent first: the faces on it. */
  onIt: Schema.Array(BotId),
  /** The bot whose action runs on the tab right now, if any. */
  acting: Schema.NullOr(BotId),
  heldBy: Schema.NullOr(BrowserTabHolder),
  dialog: Schema.NullOr(BrowserDialog),
};

/**
 * A tab, as the person's clients see it. Tabs belong to nobody: every bot
 * that may browse sees and may use each one, the person's own included, and
 * several bots may work on one.
 */
export const SharedBrowserTab = Schema.Struct({
  ...sharedTabFields,
  /**
   * A private tab, which only the person sees: no bot lists or uses it, the
   * shared sign-ins never take its cookies, and it is forgotten when closed.
   */
  private: Schema.Boolean,
});
export type SharedBrowserTab = typeof SharedBrowserTab.Type;

/** Every tab, as they are now: the list the person and the bots share. */
export const SharedBrowserTabs = Schema.Struct({ tabs: Schema.Array(SharedBrowserTab) });
export type SharedBrowserTabs = typeof SharedBrowserTabs.Type;

/**
 * A tab in one bot's view (`browser.subscribe`): a tab that bot is on. The
 * fields after `front` come from a server that shares its tabs (decision
 * 0110), and are absent from one before it.
 */
export const BrowserTab = Schema.Struct({
  ref: BrowserTabRef,
  /** The bot whose tabs were asked for. */
  botId: BotId,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  controller: BrowserController,
  /**
   * The bot's tab that most recently opened or navigated: the one to show
   * first. A pop-up a page opens, as a sign-in does, is a tab of its own and
   * becomes the front tab.
   */
  front: Schema.Boolean,
  where: Schema.optionalKey(sharedTabFields.where),
  openedBy: Schema.optionalKey(sharedTabFields.openedBy),
  onIt: Schema.optionalKey(sharedTabFields.onIt),
  acting: Schema.optionalKey(sharedTabFields.acting),
  heldBy: Schema.optionalKey(sharedTabFields.heldBy),
});
export type BrowserTab = typeof BrowserTab.Type;

/** One frame of `browser.subscribe`: every tab the bot is on, as they are now. */
export const BrowserTabs = Schema.Struct({ tabs: Schema.Array(BrowserTab) });
export type BrowserTabs = typeof BrowserTabs.Type;

// ---------------------------------------------------------------------------
// Sign-ins

/**
 * A site, as the person signs in to it: its registrable domain in ASCII
 * ("example.co.uk", "xn--bcher-kva.example"), without a scheme or a port.
 */
export const BrowserSite = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253));
export type BrowserSite = typeof BrowserSite.Type;

/**
 * The sites the person is signed in to in J3 Bots' browser, which every bot
 * that may browse uses too: the sites a shared tab showed as its page whose
 * cookies or storage the shared sign-ins hold. With another status the list
 * is empty, and nothing is signed out because of it:
 *
 * - `unreadable`: the sign-ins do not open under the secrets' key (another
 *   key, or a damaged file). Signing out of all sites starts them again.
 * - `locked`: the secrets cannot be read now, so neither can the sign-ins.
 *   Nothing can be signed out until they can.
 */
export const BrowserSignIns = Schema.Struct({
  status: Schema.Literals(["ready", "unreadable", "locked"]),
  sites: Schema.Array(Schema.Struct({ site: BrowserSite })),
});
export type BrowserSignIns = typeof BrowserSignIns.Type;

// ---------------------------------------------------------------------------
// The media socket

/** The largest picture a viewer may ask for, in device pixels. */
export const MAX_BROWSER_VIEW = { width: 3840, height: 2160 } as const;
/** What a viewer gets when it asks for no size. */
export const DEFAULT_BROWSER_VIEW = { width: 1280, height: 800, quality: 70 } as const;
/** The longest text one `text` frame types. */
export const MAX_BROWSER_TEXT_LENGTH = 10_000;
/** The longest address a `navigate` frame takes. */
export const MAX_BROWSER_URL_LENGTH = 2_048;
/**
 * How long a person holds a tab after their last input to its page, in
 * milliseconds: bots act on it again once it passes (`BrowserTabHolder`).
 */
export const BROWSER_PERSON_HOLD_MS = 10_000;

/**
 * How the server closes a media socket, besides a normal close (1000) after
 * a `gone` or `setup-needed` frame.
 *
 * - `invalid` (1008): the request named no tab or a size out of range, or the
 *   device was revoked while the socket was open.
 * - `reconnect` (1012): the browser restarted; open the socket again. Only
 *   from a server before J3 Bots' own browser (no `sharedBrowser` in the
 *   roster): on one with it, a tab whose host goes away keeps its socket and
 *   its last picture, and its pictures resume wherever it opens again.
 * - `unavailable` (1013): the engine is not ready; try again later. Only from
 *   a server before J3 Bots' own browser.
 * - `replaced` (4409): this device opened another socket on the same tab,
 *   which took this one's place, control included.
 */
export const BROWSER_CLOSE_CODES = {
  invalid: 1008,
  reconnect: 1012,
  unavailable: 1013,
  replaced: 4409,
} as const;

/** The query of a media socket's upgrade, besides the credential. */
export const BrowserViewQuery = Schema.Struct({
  ref: BrowserTabRef,
  maxWidth: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 64, maximum: MAX_BROWSER_VIEW.width }),
    ),
  ),
  maxHeight: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 64, maximum: MAX_BROWSER_VIEW.height }),
    ),
  ),
  /** JPEG quality, 1 to 100. Lower it on a slow link. */
  quality: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});
export type BrowserViewQuery = typeof BrowserViewQuery.Type;

/** A point on the page, in the page's CSS pixels (see `viewport`), never the picture's. */
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

/** Alt 1, Control 2, Meta 4, Shift 8, combined. */
const Modifiers = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }));

/** An `http:` or `https:` address: a client never opens a local file or a browser page. */
export const BrowserWebAddress = Schema.String.check(
  Schema.isMaxLength(MAX_BROWSER_URL_LENGTH),
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return "an absolute address";
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" || "an http or https address";
  }),
);

/**
 * What the server sends as JSON text. Every frame of the page itself is a
 * binary message holding one JPEG, which the client answers with `ack` once
 * it has drawn it: the server sends nothing newer until then, and only the
 * newest picture waits behind it.
 *
 * A client passes over a `type` it does not know.
 */
export const BrowserServerFrame = Schema.Union([
  /** The page's size in CSS pixels: input coordinates are in this space. */
  Schema.Struct({
    type: Schema.Literal("viewport"),
    width: NonNegativeInt,
    height: NonNegativeInt,
  }),
  /**
   * Who acts on the tab, from this socket's point of view, and the dialog the
   * page waits on, if any. `generation` grows with each change of hands.
   */
  Schema.Struct({
    type: Schema.Literal("control"),
    controller: BrowserController,
    generation: NonNegativeInt,
    dialog: Schema.NullOr(BrowserDialog),
  }),
  /** The answer to a `probe`: whether a tap there lands in a field that takes text. */
  Schema.Struct({
    type: Schema.Literal("probe"),
    x: Coordinate,
    y: Coordinate,
    editable: Schema.Boolean,
  }),
  /**
   * Where a bot points while it acts on the tab, and when it clicks: sent
   * only while a bot acts, never for a person's input. `botId` names the
   * bot, since several may work on one tab; a server from before shared
   * tabs leaves it out, and the pointer is then the tab's one bot's.
   */
  Schema.Struct({
    type: Schema.Literal("cursor"),
    action: Schema.Literals(["move", "click"]),
    x: Coordinate,
    y: Coordinate,
    botId: Schema.optionalKey(BotId),
  }),
  /**
   * The engine's browser cannot start until the host is set up; `j3-bots
   * doctor` says how. Only from a server before J3 Bots' own browser (no
   * `sharedBrowser` in the roster): on one with it, the engine status's
   * `browser` says whether the server's own browser can run.
   */
  Schema.Struct({
    type: Schema.Literal("setup-needed"),
    need: Schema.Literals(["sandbox", "libraries"]),
  }),
  /** The tab is closed, or never existed. */
  Schema.Struct({ type: Schema.Literal("gone") }),
  /** Sent every 15 s; answer with `pong`. A socket silent for 45 s is taken for dropped. */
  Schema.Struct({ type: Schema.Literal("ping") }),
]);
export type BrowserServerFrame = typeof BrowserServerFrame.Type;

/**
 * Input a person gives the page itself, through a viewer or a page host's
 * own view: what makes them hold the tab (`BrowserTabHolder`).
 */
const pageInputFrames = [
  Schema.Struct({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Coordinate,
    y: Coordinate,
    button: Schema.Literals(["none", "left", "middle", "right"]),
    /** The buttons held, as a bit set: left 1, right 2, middle 4. */
    buttons: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    clickCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: Coordinate,
    y: Coordinate,
    deltaX: Coordinate,
    deltaY: Coordinate,
    modifiers: Modifiers,
  }),
  /** One key, as `KeyboardEvent` names it. Typed text goes as `text`. */
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: Schema.String.check(Schema.isMaxLength(64)),
    code: Schema.String.check(Schema.isMaxLength(64)),
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
    keyCode: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
    modifiers: Modifiers,
  }),
  /** Text typed where the page has focus, as a keyboard's committed text. */
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BROWSER_TEXT_LENGTH)),
  }),
] as const;

/** The page input of `BrowserClientFrame`, which a page host applies (`tab.input`). */
export const BrowserPageInput = Schema.Union(pageInputFrames);
export type BrowserPageInput = typeof BrowserPageInput.Type;

/**
 * What a client sends, as JSON text.
 *
 * On a server that shares its tabs (the roster's `sharedBrowser`), using the
 * page is taking it: page input holds the tab for this socket's person until
 * `BROWSER_PERSON_HOLD_MS` after the last, and is dropped while a person on
 * another device holds it. On a server from before, input is dropped unless
 * this socket holds the tab (`take`). `ack`, `pong`, `take` and `probe` work
 * either way.
 */
export const BrowserClientFrame = Schema.Union([
  /** The last picture is drawn: send the next. */
  Schema.Struct({ type: Schema.Literal("ack") }),
  Schema.Struct({ type: Schema.Literal("pong") }),
  /**
   * "Wait for me": hold the tab until `release`, with no end of its own
   * (`until` null). On a server from before shared tabs, take it from the
   * bot. Fails, and changes nothing, while another device holds it.
   */
  Schema.Struct({ type: Schema.Literal("take") }),
  /**
   * Give the tab back to the bots now. With `idle`, stop holding it with no
   * end but keep the hold `BROWSER_PERSON_HOLD_MS` from now, as after any
   * input: a phone's keyboard closing ends an open hold this way. A server
   * from before shared tabs gives it back at once either way.
   */
  Schema.Struct({
    type: Schema.Literal("release"),
    idle: Schema.optionalKey(Schema.Literal(true)),
  }),
  ...pageInputFrames,
  Schema.Struct({ type: Schema.Literal("navigate"), url: BrowserWebAddress }),
  Schema.Struct({ type: Schema.Literal("back") }),
  Schema.Struct({ type: Schema.Literal("forward") }),
  Schema.Struct({ type: Schema.Literal("reload") }),
  /** Whether the point lands in a field that takes text; answered with `probe`. */
  Schema.Struct({ type: Schema.Literal("probe"), x: Coordinate, y: Coordinate }),
  /** Answer the dialog the page waits on. */
  Schema.Struct({
    type: Schema.Literal("dialog"),
    accept: Schema.Boolean,
    promptText: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(MAX_BROWSER_TEXT_LENGTH)),
    ),
  }),
]);
export type BrowserClientFrame = typeof BrowserClientFrame.Type;

/** What a client sends that acts on the page or its control, rather than the socket. */
export type BrowserInput = Exclude<BrowserClientFrame, { readonly type: "ack" | "pong" }>;
