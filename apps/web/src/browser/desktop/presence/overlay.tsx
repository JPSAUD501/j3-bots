// SPDX-License-Identifier: AGPL-3.0-or-later
// The bots' pointers in a page of the desktop's browser (docs/architecture/browser.md,
// "Presence in the page"). The main process runs this bundle in a world of its own in
// the tab's page, then hands each `PresenceCall` to the global it defines. It draws
// the pointers a view of the tab draws over its picture, with the same component, in
// a closed shadow root: the page's scripts cannot reach it, no reader of the page
// lists it, and no click lands on it.
import type { BrowserCursor } from "@j3-bots/client-runtime";
import { PRESENCE_GLOBAL, PresenceCall, type PresenceBot } from "@j3-bots/desktop-bridge/presence";
import { resolveAvatar } from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { type CursorSource, TabPointers } from "../../TabPointers";
import css from "./presence.css?inline";

interface Drawn {
  readonly bots: ReadonlyArray<PresenceBot>;
  readonly held: boolean;
  readonly hidden: boolean;
}

const NOBODY: Drawn = { bots: [], held: false, hidden: false };

/**
 * The element the drawing lives in, at the page's root. Its own style wins
 * over the page's: it covers the viewport, above all but the top layer, and
 * takes no pointer. Set property by property, which a page's policy that
 * refuses style attributes lets through.
 */
const styleHost = (host: HTMLElement, hidden: boolean) => {
  for (const [name, value] of [
    ["all", "initial"],
    // Not reset by `all`: a right-to-left page would mirror the tag.
    ["direction", "ltr"],
    ["display", "block"],
    ["position", "fixed"],
    ["inset", "0"],
    ["z-index", "2147483647"],
    ["pointer-events", "none"],
    ["contain", "strict"],
    ["visibility", hidden ? "hidden" : "visible"],
  ] as const) {
    host.style.setProperty(name, value, "important");
  }
};

/**
 * The sheet a shadow root can use. A shadow root's sheet registers no custom
 * property, so each one Tailwind registers starts at its initial value on
 * every element instead, in a layer below all of Tailwind's.
 */
const presenceSheet = (): CSSStyleSheet => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const initial: Array<string> = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSPropertyRule) {
        if (rule.initialValue !== null) initial.push(`${rule.name}: ${rule.initialValue};`);
      } else if (rule instanceof CSSGroupingRule) {
        collect(rule.cssRules);
      }
    }
  };
  collect(sheet.cssRules);
  sheet.insertRule(
    `@layer presence-properties { *, ::before, ::after { ${initial.join(" ")} } }`,
    0,
  );
  return sheet;
};

/** The element that has the focus: through open shadow roots, and into each frame of the page's own origin. */
const focusedField = (): HTMLElement | null => {
  let element: Element | null = document.activeElement;
  for (;;) {
    while (element?.shadowRoot?.activeElement != null) element = element.shadowRoot.activeElement;
    if (element === null) return null;
    const frame = element.ownerDocument.defaultView;
    if (frame === null) return null;
    if (element instanceof frame.HTMLIFrameElement) {
      // A frame of another origin has no document to read: its caret keeps the page's color.
      const inner = element.contentDocument;
      if (inner === null) return null;
      watchFocus(inner);
      element = inner.activeElement;
      continue;
    }
    if (!(element instanceof frame.HTMLElement)) return null;
    const field =
      element.isContentEditable ||
      element instanceof frame.HTMLTextAreaElement ||
      element instanceof frame.HTMLInputElement;
    return field ? element : null;
  }
};

/** The field whose caret is a bot's, and the caret color it had. */
let careted: {
  readonly field: HTMLElement;
  readonly color: string;
  readonly priority: string;
} | null = null;

const giveCaretBack = () => {
  if (careted === null) return;
  const { field, color, priority } = careted;
  careted = null;
  if (color === "") field.style.removeProperty("caret-color");
  else field.style.setProperty("caret-color", color, priority);
};

let drawn: Drawn = NOBODY;
let palette: HTMLElement | null = null;

/** The focused field's caret is the bot's on the tab, while it acts there: the person's while they hold it. */
const colorCaret = () => {
  const bot = drawn.bots[0];
  const field = bot === undefined || drawn.held || palette === null ? null : focusedField();
  if (field !== careted?.field) giveCaretBack();
  if (field === null || bot === undefined || palette === null) return;
  const ink = getComputedStyle(palette)
    .getPropertyValue(`--bot-${resolveAvatar(bot.profile.avatar).color}`)
    .trim();
  careted ??= {
    field,
    color: field.style.getPropertyValue("caret-color"),
    priority: field.style.getPropertyPriority("caret-color"),
  };
  field.style.setProperty("caret-color", ink, "important");
};

const watched = new WeakSet<Document>();
/** Hears focus move in `place`: the page, and each frame of its origin that the focus went into. */
function watchFocus(place: Document) {
  if (watched.has(place)) return;
  watched.add(place);
  place.addEventListener("focusin", colorCaret, true);
  // Leaving for a frame, the page's focus is not on the frame's field yet.
  place.addEventListener("focusout", () => window.setTimeout(colorCaret), true);
}

const changes = new Set<() => void>();
const cursors = new Set<(cursor: BrowserCursor) => void>();
/** Where the tab's bot last pointed in this page: a pointer drawn again shows there, without clicking again. */
let lastCursor: BrowserCursor | null = null;
const source: CursorSource = {
  onCursor: (listener) => {
    cursors.add(listener);
    if (lastCursor !== null) listener({ ...lastCursor, action: "move" });
    return () => {
      cursors.delete(listener);
    };
  },
};

/** The stage's size: the viewport without its scrollbars, where a bot's point is measured. */
let viewport: { readonly width: number; readonly height: number } | null = null;

const subscribe = (change: () => void) => {
  changes.add(change);
  return () => {
    changes.delete(change);
  };
};

function Pointers() {
  const now = useSyncExternalStore(subscribe, () => drawn);
  const size = useSyncExternalStore(subscribe, () => viewport);
  return (
    <TabPointers
      source={source}
      // One document: where a pointer was holds while the page stays.
      place="page"
      viewport={size}
      bots={now.bots}
      held={now.held}
    />
  );
}

/**
 * The drawing, in this page and this world: the element at the page's root
 * holding a closed shadow root, put back there while a bot is on the tab if
 * the page takes it out, and gone while none is.
 */
const start = () => {
  const host = document.createElement("j3-presence");
  host.setAttribute("aria-hidden", "true");
  styleHost(host, false);
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [presenceSheet()];
  const stage = document.createElement("div");
  // The client's type, which the host's reset leaves for the page's default.
  stage.className = "absolute inset-0 overflow-hidden text-foreground antialiased";
  // The system's own type, by generic names alone: a page's font faces apply in a
  // shadow root, and could stand in for any family named here.
  stage.style.setProperty("font-family", "ui-sans-serif, system-ui, sans-serif");
  shadow.append(stage);
  palette = stage;
  createRoot(stage).render(<Pointers />);

  const keeper = new MutationObserver(() => place());
  keeper.observe(document, { childList: true });
  let kept: Element | null = null;
  const place = () => {
    const top = document.documentElement;
    if (top !== kept && top !== null) {
      kept = top;
      keeper.observe(top, { childList: true });
    }
    if (drawn.bots.length === 0) host.remove();
    else if (top !== null && host.parentNode !== top) top.append(host);
  };
  watchFocus(document);
  new ResizeObserver(() => {
    // Out of the page, the stage has no size: the pointers keep the last one.
    if (stage.clientWidth === 0 || stage.clientHeight === 0) return;
    viewport = { width: stage.clientWidth, height: stage.clientHeight };
    for (const change of changes) change();
  }).observe(stage);

  const answer = (input: unknown): void => {
    const call = Schema.decodeUnknownOption(PresenceCall)(input);
    if (Option.isNone(call)) return;
    if (call.value._tag === "point") {
      const { action, x, y, sequence } = call.value;
      // The tab's most recent bot is the one acting: the host's pointer names none.
      lastCursor = { action, x, y, sequence, botId: null };
      for (const listener of cursors) listener(lastCursor);
      return;
    }
    const { bots, held, hidden } = call.value;
    drawn = { bots, held, hidden };
    if (bots.length === 0) lastCursor = null;
    styleHost(host, hidden);
    place();
    colorCaret();
    for (const change of changes) change();
  };
  Object.defineProperty(globalThis, PRESENCE_GLOBAL, { value: answer });
};

// Once in a world: the main process asks before it runs the bundle, and runs no two at once.
if (!(PRESENCE_GLOBAL in globalThis)) start();
