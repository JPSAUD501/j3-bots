// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BrowserInput, MAX_BROWSER_TEXT_LENGTH, MAX_BROWSER_VIEW } from "@j3-bots/contracts";

// How what the operator does over the drawn picture becomes what the media
// socket carries: a point on the picture becomes one on the page, in the
// page's CSS pixels, and a key becomes either a key the page receives as
// pressed or text it receives as typed.

/** A size in CSS pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Where the picture is drawn on screen, as `getBoundingClientRect` gives it. */
export interface DrawnRect extends Size {
  readonly left: number;
  readonly top: number;
}

/** The modifier keys held, as the contract's bit set: Alt 1, Control 2, Meta 4, Shift 8. */
export const modifiersOf = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

/**
 * The point on the page under `client`, a point on screen over the picture
 * drawn at `rect` of a page of `viewport`. A point past the picture's edge, as
 * a drag that leaves it, is held to the edge.
 */
export const pagePoint = (
  rect: DrawnRect,
  viewport: Size,
  client: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } => {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const scaleX = rect.width > 0 ? viewport.width / rect.width : 0;
  const scaleY = rect.height > 0 ? viewport.height / rect.height : 0;
  return {
    x: Math.round(clamp((client.x - rect.left) * scaleX, viewport.width) * 100) / 100,
    y: Math.round(clamp((client.y - rect.top) * scaleY, viewport.height) * 100) / 100,
  };
};

const BUTTONS = ["left", "middle", "right"] as const;

/** The button of a pointer event (`MouseEvent.button`) as the contract names it. */
export const buttonOf = (button: number): "none" | "left" | "middle" | "right" =>
  BUTTONS[button] ?? "none";

/** The DOM's pressed-buttons bits, left 1, right 2, middle 4, are the contract's. */
export const buttonsOf = (buttons: number): number => buttons & 7;

/** `WheelEvent.deltaMode`: pixels, lines or pages. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT = 16;

/**
 * A wheel's scroll in page CSS pixels: the distance it scrolls the picture,
 * scaled from the drawn size to the page's, so a page scrolls as far as the
 * picture appears to.
 */
export const wheelDelta = (
  event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
  rect: Size,
  viewport: Size,
): { readonly deltaX: number; readonly deltaY: number } => {
  const unit =
    event.deltaMode === DOM_DELTA_LINE
      ? LINE_HEIGHT
      : event.deltaMode === DOM_DELTA_PAGE
        ? rect.height
        : 1;
  const scale = rect.width > 0 ? viewport.width / rect.width : 1;
  const bound = (value: number) => Math.min(Math.max(value, -100_000), 100_000);
  return {
    deltaX: bound(Math.round(event.deltaX * unit * scale)),
    deltaY: bound(Math.round(event.deltaY * unit * scale)),
  };
};

/** The virtual key codes Chromium needs to run a key that edits or moves, by `KeyboardEvent.key`. */
const KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

/**
 * The Windows virtual key code of a key that names no key of its own, from
 * where it sits on the keyboard (`code`), as Chromium gives it: a letter or a
 * digit by its character, punctuation by its own code, so Control with a
 * period is not taken for Delete.
 */
const PUNCTUATION_CODES: Readonly<Record<string, number>> = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
};

const keyCodeOf = (key: string, code: string): number | null => {
  const named = KEY_CODES[key];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return 48 + Number(digit);
  const numpad = /^Numpad([0-9])$/.exec(code)?.[1];
  if (numpad !== undefined) return 96 + Number(numpad);
  return PUNCTUATION_CODES[code] ?? null;
};

/** Enter types a carriage return as it is pressed, which is what submits a form. */
const ENTER_TEXT = "\r";

/** The key that moves focus out of the page and back to the viewer's controls. */
export const LEAVE_PAGE_KEY = "F6";

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  /** `KeyboardEvent.keyCode`, 229 while an input method holds the key. */
  readonly keyCode: number;
  /** Whether AltGr is held: Ctrl and Alt then type a character, as on many European layouts. */
  readonly altGraph: boolean;
}

/**
 * Whether the key types a character that arrives as text: a printable key
 * with no shortcut modifier, or one an input method is composing. Those go to
 * the page as `text`, from the text field's own input, so dead keys, AltGr
 * and input methods type what the operator's keyboard types.
 */
export const typesText = (event: KeyLike): boolean => {
  if (event.isComposing || event.keyCode === 229 || event.key === "Process") return true;
  if ([...event.key].length !== 1) return event.key === "Dead";
  if (event.altGraph) return true;
  return !event.ctrlKey && !event.metaKey && !event.altKey;
};

/**
 * The `key` frame for a key that does not type text, or null for one that
 * does (`typesText`): a key the page should receive as pressed, as Enter,
 * Backspace, the arrows, or a letter with Control.
 */
export const keyFrame = (
  event: KeyLike,
  action: "down" | "up",
): Extract<BrowserInput, { readonly type: "key" }> | null => {
  if (typesText(event)) return null;
  const keyCode = keyCodeOf(event.key, event.code);
  const text = action === "down" && event.key === "Enter" ? ENTER_TEXT : undefined;
  return {
    type: "key",
    action,
    key: event.key.slice(0, 64),
    code: event.code.slice(0, 64),
    ...(text === undefined ? {} : { text }),
    ...(keyCode === null ? {} : { keyCode }),
    modifiers: modifiersOf(event),
  };
};

/**
 * Typed text as `text` frames, each within what one frame takes. Text longer
 * than that, as a long paste would be, is cut at a character's boundary.
 */
export const textFrames = (
  text: string,
): ReadonlyArray<Extract<BrowserInput, { readonly type: "text" }>> => {
  const frames: Array<Extract<BrowserInput, { readonly type: "text" }>> = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > MAX_BROWSER_TEXT_LENGTH) {
      frames.push({ type: "text", text: chunk });
      chunk = "";
    }
    chunk += character;
  }
  if (chunk.length > 0) frames.push({ type: "text", text: chunk });
  return frames;
};

/**
 * The picture's size to ask for: the box it is drawn in, in device pixels, so
 * a frame is never larger than the screen shows it, within what the server
 * takes.
 */
export const viewSize = (
  box: Size,
  devicePixelRatio: number,
): { readonly maxWidth: number; readonly maxHeight: number } => {
  const scale = Math.max(devicePixelRatio, 1);
  const fit = (value: number, max: number) =>
    Math.min(Math.max(Math.round(value * scale), 64), max);
  return {
    maxWidth: fit(box.width, MAX_BROWSER_VIEW.width),
    maxHeight: fit(box.height, MAX_BROWSER_VIEW.height),
  };
};

/** Whether a new size is far enough from the one asked for to open the picture again at it. */
export const sizeChanged = (
  asked: { readonly maxWidth: number; readonly maxHeight: number },
  next: { readonly maxWidth: number; readonly maxHeight: number },
): boolean =>
  Math.abs(next.maxWidth - asked.maxWidth) / asked.maxWidth > 0.15 ||
  Math.abs(next.maxHeight - asked.maxHeight) / asked.maxHeight > 0.15;

/** What the browser says of its link, where it says anything (the Network Information API). */
export interface LinkHint {
  /** "cellular", "wifi", and so on; Chrome on Android says it. */
  readonly type?: string;
  readonly effectiveType?: string;
  readonly saveData?: boolean;
}

/** The JPEG quality to ask for on a good link. */
export const GOOD_QUALITY = 70;
/** On a phone's mobile data, which costs the operator. */
export const CELLULAR_QUALITY = 60;
/** On a slow link, or when the operator asked to save data: each round trip shorter. */
export const SLOW_QUALITY = 50;

/**
 * The quality for the next socket: lower on mobile data, and lower still when
 * the browser calls the link slow or asks to save data. A page sends a
 * picture only when it changes, so the time between pictures says nothing of
 * the link, and is not measured.
 */
export const viewQuality = (hint: LinkHint | null): number => {
  if (hint === null) return GOOD_QUALITY;
  if (hint.saveData === true || ["slow-2g", "2g", "3g"].includes(hint.effectiveType ?? ""))
    return SLOW_QUALITY;
  return hint.type === "cellular" ? CELLULAR_QUALITY : GOOD_QUALITY;
};
