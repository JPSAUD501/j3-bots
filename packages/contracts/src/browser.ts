// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, MAX_ID_LENGTH, NonNegativeInt } from "./base.ts";

// The bot's browser: the tabs a bot opened in the engine's headless browser,
// which a client lists on the RPC socket (`browser.subscribe`) and watches and
// controls on the media socket (`HTTP_PATHS.browser`). A client never sees an
// engine id: a tab is named by a `BrowserTabRef` the server mints.

/**
 * One tab, as the server names it to clients. Opaque: minted by the server
 * for as long as it runs, so a ref from before a restart names nothing.
 */
export const BrowserTabRef = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ID_LENGTH),
).pipe(Schema.brand("BrowserTabRef"));
export type BrowserTabRef = typeof BrowserTabRef.Type;

/**
 * Who acts on a tab, as the reader of the value sees it.
 *
 * - `bot`: the bot that opened it; nobody holds it.
 * - `you`: on the tab list, this device; on the media socket, this socket.
 * - `another-device`: a person on another device, or on another socket of
 *   this one, holds it. The bot cannot act on the tab meanwhile.
 * - `nobody`: no bot and no person.
 */
export const BrowserController = Schema.Literals(["bot", "you", "another-device", "nobody"]);
export type BrowserController = typeof BrowserController.Type;

export const BrowserTab = Schema.Struct({
  ref: BrowserTabRef,
  botId: BotId,
  /** Empty for a tab that has not loaded a page yet. */
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
});
export type BrowserTab = typeof BrowserTab.Type;

/** One frame of `browser.subscribe`: every tab of the bot, as they are now. */
export const BrowserTabs = Schema.Struct({ tabs: Schema.Array(BrowserTab) });
export type BrowserTabs = typeof BrowserTabs.Type;

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
 * How the server closes a media socket, besides a normal close (1000) after
 * a `gone` or `setup-needed` frame.
 *
 * - `invalid` (1008): the request named no tab or a size out of range, or the
 *   device was revoked while the socket was open.
 * - `reconnect` (1012): the browser restarted; open the socket again.
 * - `unavailable` (1013): the engine is not ready; try again later.
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
const WebAddress = Schema.String.check(
  Schema.isMaxLength(MAX_BROWSER_URL_LENGTH),
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return "an absolute address";
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" || "an http or https address";
  }),
);

const DialogKind = Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]);

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
    dialog: Schema.NullOr(
      Schema.Struct({ kind: DialogKind, message: Schema.String, defaultValue: Schema.String }),
    ),
  }),
  /** The answer to a `probe`: whether a tap there lands in a field that takes text. */
  Schema.Struct({
    type: Schema.Literal("probe"),
    x: Coordinate,
    y: Coordinate,
    editable: Schema.Boolean,
  }),
  /** The engine's browser cannot start until the host is set up; `j3-bots doctor` says how. */
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
 * What a client sends, as JSON text. Input is dropped unless this socket
 * holds the tab (`take`); `ack`, `pong`, `take` and `probe` work either way.
 */
export const BrowserClientFrame = Schema.Union([
  /** The last picture is drawn: send the next. */
  Schema.Struct({ type: Schema.Literal("ack") }),
  Schema.Struct({ type: Schema.Literal("pong") }),
  /** Take the tab from the bot. Fails, and changes nothing, while another device holds it. */
  Schema.Struct({ type: Schema.Literal("take") }),
  /** Give the tab back to the bot. */
  Schema.Struct({ type: Schema.Literal("release") }),
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
  Schema.Struct({ type: Schema.Literal("navigate"), url: WebAddress }),
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
