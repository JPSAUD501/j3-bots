// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserTabRef, DeviceId, DeviceToken, ServerOrigin } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// The desktop app's own browser (decision 0110), as its windows show it: the
// tabs the main process runs in views of the app, the person's commands on
// them, and where each window draws the tab in front. The server drives the
// same tabs over the page host link the main process keeps; what the bots
// are doing on a tab comes to the page from the server, not from here.

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Address = Text(8192);
const Percent = Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 500 }));
const Pixels = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

/** Where a tab is shown: beside the conversation, or in the browser's own window. */
export const BrowserPlace = Schema.Literals(["panel", "window"]);
export type BrowserPlace = typeof BrowserPlace.Type;

/**
 * The server the main window's page is signed in to, which the browser
 * serves: its origin, and the device's id and token there. `null` signs the
 * browser out: the server no longer drives it.
 */
export const BrowserLink = Schema.NullOr(
  Schema.Struct({ server: ServerOrigin, deviceId: DeviceId, token: DeviceToken }),
);
export type BrowserLink = typeof BrowserLink.Type;

/** A tab, as the app's windows draw it. */
export const DesktopBrowserTab = Schema.Struct({
  ref: BrowserTabRef,
  /** Empty for a new tab that has not loaded a page. */
  url: Address,
  title: Text(1024),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** The page's zoom, which holds for its whole site. */
  zoom: Percent,
  /** A private tab: no bot sees it, and it forgets everything as it closes. */
  private: Schema.Boolean,
  place: BrowserPlace,
  /** The page failed to load: the site it was going to, for the page that says so. */
  failed: Schema.NullOr(Schema.Struct({ url: Address })),
});
export type DesktopBrowserTab = typeof DesktopBrowserTab.Type;

/**
 * A download, as the downloads list shows it. `bot`: a bot's, which the
 * server takes into the bot's conversation; `tab` names the tab it came
 * from, so the page can say which bot was on it.
 */
export const DesktopDownload = Schema.Struct({
  id: Text(64),
  name: Text(1024),
  received: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** 0 when the site did not say. */
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literals(["progressing", "completed", "cancelled", "interrupted"]),
  by: Schema.Literals(["person", "bot"]),
  tab: Schema.NullOr(BrowserTabRef),
  /** When it began, in milliseconds since the epoch. */
  at: Schema.Int,
  /**
   * In the person's downloads folder, theirs to open: what they downloaded,
   * and a bot's file too large for the server.
   */
  inDownloads: Schema.Boolean,
});
export type DesktopDownload = typeof DesktopDownload.Type;

/**
 * The browser now. `front` is the tab each place shows; `windowOpen`
 * whether the browser's own window is open. `canReopen`: a closed tab can
 * be opened again.
 */
export const DesktopBrowserState = Schema.Struct({
  tabs: Schema.Array(DesktopBrowserTab),
  front: Schema.Struct({
    panel: Schema.NullOr(BrowserTabRef),
    window: Schema.NullOr(BrowserTabRef),
  }),
  windowOpen: Schema.Boolean,
  canReopen: Schema.Boolean,
  downloads: Schema.Array(DesktopDownload),
});
export type DesktopBrowserState = typeof DesktopBrowserState.Type;

const OnTab = { tab: BrowserTabRef };

/** What the person asks of the browser from a window's controls. */
export const DesktopBrowserCommand = Schema.Union([
  /** A new tab in `place`, at what was typed (an address or words to search), or blank. */
  Schema.TaggedStruct("open", {
    input: Schema.optionalKey(Text(8192)),
    private: Schema.Boolean,
    place: BrowserPlace,
  }),
  Schema.TaggedStruct("close", OnTab),
  Schema.TaggedStruct("reopen", { place: BrowserPlace }),
  /** Puts the tab in front of `place`, moving it there if it was in the other. */
  Schema.TaggedStruct("show", { ...OnTab, place: BrowserPlace }),
  /** What the person typed in the address bar: an address, or words to search. */
  Schema.TaggedStruct("go", { ...OnTab, input: Text(8192) }),
  Schema.TaggedStruct("back", OnTab),
  Schema.TaggedStruct("forward", OnTab),
  Schema.TaggedStruct("reload", OnTab),
  Schema.TaggedStruct("stop", OnTab),
  Schema.TaggedStruct("zoom", { ...OnTab, to: Schema.Literals(["in", "out", "reset"]) }),
  /** Finds `text` in the page, the next match (`forward`) or the one before. */
  Schema.TaggedStruct("find", { ...OnTab, text: Text(1024), forward: Schema.Boolean }),
  Schema.TaggedStruct("stopFinding", OnTab),
  Schema.TaggedStruct("print", OnTab),
  Schema.TaggedStruct("openDownload", { id: Text(64) }),
  Schema.TaggedStruct("showDownload", { id: Text(64) }),
  Schema.TaggedStruct("cancelDownload", { id: Text(64) }),
  /** Closes the browser's own window; its tabs go beside the conversation. */
  Schema.TaggedStruct("closeWindow", {}),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

const Bounds = Schema.Struct({ x: Pixels, y: Pixels, width: Pixels, height: Pixels });

/**
 * Where a window's page wants its place's front tab drawn, in the page's CSS
 * pixels, or `null` when it shows none. `covered`: something of the page lies
 * over that area (a menu, the suggestions), so the tab is drawn as a still
 * picture until it is not.
 */
export const BrowserPlacement = Schema.Struct({
  bounds: Schema.NullOr(Bounds),
  covered: Schema.Boolean,
});
export type BrowserPlacement = typeof BrowserPlacement.Type;

/** A still picture of a tab, for the page to draw while it covers the tab. */
export const BrowserStill = Schema.Struct({
  tab: BrowserTabRef,
  image: Schema.String.check(Schema.isStartingWith("data:image/"), Schema.isMaxLength(20_000_000)),
});
export type BrowserStill = typeof BrowserStill.Type;

/** How finding in a page went: the match shown, of how many. */
export const BrowserFound = Schema.Struct({
  tab: BrowserTabRef,
  active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  matches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BrowserFound = typeof BrowserFound.Type;

/**
 * A browser shortcut pressed while a tab's page had the keys: the page of
 * the tab's window handles it as if pressed there.
 */
export const BrowserShortcut = Schema.Literals([
  "newTab",
  "newPrivateTab",
  "closeTab",
  "reopenTab",
  "nextTab",
  "previousTab",
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "lastTab",
  "address",
  "back",
  "forward",
  "reload",
  "stop",
  "find",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "downloads",
  "history",
  "print",
  "togglePlace",
  "botConversation",
]);
export type BrowserShortcut = typeof BrowserShortcut.Type;

/** What the address bar suggests for what is typed, best first. */
export const BrowserSuggestion = Schema.Union([
  Schema.TaggedStruct("tab", { tab: BrowserTabRef, url: Address, title: Text(1024) }),
  Schema.TaggedStruct("visited", {
    url: Address,
    title: Text(1024),
    /** Whether a bot's page went there, as against the person's. */
    byBot: Schema.Boolean,
    at: Schema.Int,
  }),
  Schema.TaggedStruct("search", { text: Text(1024) }),
]);
export type BrowserSuggestion = typeof BrowserSuggestion.Type;

/** What is typed in the address bar; or, with `recent`, the latest visits, for the history. */
export const BrowserSuggestRequest = Schema.Struct({
  text: Text(1024),
  recent: Schema.optionalKey(Schema.Boolean),
});
export type BrowserSuggestRequest = typeof BrowserSuggestRequest.Type;

/** A key pressed, as both a page's keyboard event and Electron's input give it. */
export interface PressedKey {
  /** The key's value (`KeyboardEvent.key`). */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const TAB_KEYS: ReadonlyArray<BrowserShortcut> = [
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "lastTab",
];

/**
 * The browser shortcut `pressed` is, if any: the ones every browser has,
 * with ⌘ in place of Ctrl on a Mac. Escape stops a page only while it loads;
 * otherwise it is the page's.
 */
export const browserShortcutOf = (
  pressed: PressedKey,
  options: { readonly mac: boolean; readonly loading: boolean },
): BrowserShortcut | null => {
  const { ctrl, meta, shift, alt } = pressed;
  const key = pressed.key.length === 1 ? pressed.key.toLowerCase() : pressed.key;
  const command = options.mac ? meta && !ctrl : ctrl && !meta;
  if (key === "Tab" && ctrl && !alt) return shift ? "previousTab" : "nextTab";
  if (!command) {
    if (alt && !ctrl && !meta && !shift && !options.mac) {
      if (key === "ArrowLeft") return "back";
      if (key === "ArrowRight") return "forward";
    }
    if (!ctrl && !meta && !alt && !shift) {
      if (key === "F5") return "reload";
      if (key === "Escape" && options.loading) return "stop";
    }
    return null;
  }
  if (alt) return null;
  if (shift) {
    switch (key) {
      case "n":
        return "newPrivateTab";
      case "t":
        return "reopenTab";
      case "d":
        return "togglePlace";
      case "k":
        return "botConversation";
      case "+":
        return "zoomIn";
      default:
        return null;
    }
  }
  const digit = /^[1-9]$/.test(key) ? Number(key) : null;
  if (digit !== null) return TAB_KEYS[digit - 1] ?? null;
  switch (key) {
    case "t":
      return "newTab";
    case "w":
      return "closeTab";
    case "l":
      return "address";
    case "r":
      return "reload";
    case "f":
      return "find";
    case "=":
    case "+":
      return "zoomIn";
    case "-":
      return "zoomOut";
    case "0":
      return "zoomReset";
    case "j":
      return "downloads";
    case "h":
      // ⌘H hides the app on a Mac; its history is ⌘Y.
      return options.mac ? null : "history";
    case "y":
      return options.mac ? "history" : null;
    case "p":
      return "print";
    case "[":
      return options.mac ? "back" : null;
    case "]":
      return options.mac ? "forward" : null;
    default:
      return null;
  }
};
