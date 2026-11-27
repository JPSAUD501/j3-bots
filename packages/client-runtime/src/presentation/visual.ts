// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  clampVisualHeight,
  VISUAL_CONTENT_SECURITY_POLICY,
  visualEscapesGuard,
} from "@j3-bots/contracts";
import { type Palette, visualVariables } from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How every client wraps a bot's visual before it renders it, so the web, the
 * desktop app and Android shut it in the same way: the document is this one,
 * always in a frame sandboxed with scripts only (the client's own visual page
 * on the web and the desktop, `visualShell` in a WebView).
 * docs/architecture/security.md, "Visuals", says why each rule is there.
 */

export type VisualAppearance = "light" | "dark";

/**
 * The `sandbox` of a visual's frame: scripts, and nothing else. Never
 * `allow-same-origin`, which would give the page the client's origin, its
 * storage and its session; never top navigation, popups or forms. Every
 * document the page makes inherits it, so each has an opaque origin of its
 * own and the page cannot reach into it.
 */
export const VISUAL_FRAME_SANDBOX = "allow-scripts";

/** The one message a client takes from a visual: the height its content needs. */
export const VISUAL_HEIGHT_MESSAGE = "j3-visual-height";

/**
 * What `visualShell` tells the app when the visual's frame shows something
 * else: the visual navigated it.
 */
const VISUAL_GONE_MESSAGE = "j3-visual-gone";

/**
 * The object an Android WebView puts on `visualShell`'s window to take a
 * visual's height: a `postMessage(string)` that receives the message as JSON.
 * Android's side names it with the same literal.
 */
export const VISUAL_BRIDGE = "J3Visual";

// The first script of a visual's document, and of a connector's app's
// (`connectorAppDocument`), before any of the page's, shuts the ways out a
// policy does not:
// - WebRTC. No policy Chromium enforces covers it (`connect-src` does not,
//   and it does not know a `webrtc` directive), so a peer connection could
//   reach any address. Every RTC interface is deleted from the page's realm
//   before the page runs, so none of its scripts can make one.
// - Another realm, which would have them all again. A visual holds no nested
//   document: `visualDocument` refuses a page whose markup has one, and this
//   removes every frame a script adds, to the document or to a shadow root
//   (each attached unclonable, so no copy of one escapes it),
//   at the next microtask, before the frame's document can load. The ways to
//   parse a declarative shadow root, whose inside this could not see, are
//   deleted, with `document.write`. A nested document is cross-origin to the
//   page in any case, from the moment it exists, since the sandbox gives each
//   an opaque origin of its own, and the policy starts no worker.
// It keeps the built-ins it uses, so the page cannot turn it off by replacing
// them. docs/architecture/security.md, "Visuals", has the proof.
export const PAGE_GUARD = `(function () {
  "use strict";
  var apply = Reflect.apply, drop = Reflect.deleteProperty, describe = Object.getOwnPropertyDescriptor;
  var names = Object.getOwnPropertyNames(window);
  for (var i = 0; i < names.length; i++) if (/^(webkit)?RTC/.test(names[i])) drop(window, names[i]);
  var parsers = [
    [Document.prototype, "open"], [Document.prototype, "write"], [Document.prototype, "writeln"],
    [Document, "parseHTMLUnsafe"], [Document, "parseHTML"], [Element.prototype, "setHTMLUnsafe"], [Element.prototype, "setHTML"],
    [ShadowRoot.prototype, "setHTMLUnsafe"], [ShadowRoot.prototype, "setHTML"]
  ];
  for (i = 0; i < parsers.length; i++) drop(parsers[i][0], parsers[i][1]);
  var FRAMES = "iframe,frame,object,embed";
  var nodeType = describe(Node.prototype, "nodeType").get;
  var addedNodes = describe(MutationRecord.prototype, "addedNodes").get;
  var length = describe(NodeList.prototype, "length").get, item = NodeList.prototype.item;
  var matches = Element.prototype.matches, detach = Element.prototype.remove;
  var inElement = Element.prototype.querySelectorAll, inFragment = DocumentFragment.prototype.querySelectorAll;
  var observe = MutationObserver.prototype.observe, attachShadow = Element.prototype.attachShadow;
  var options = { __proto__: null, childList: true, subtree: true };
  var each = function (list, run) {
    for (var j = 0, n = apply(length, list, []); j < n; j++) run(apply(item, list, [j]));
  };
  var remove = function (frame) { apply(detach, frame, []); };
  var sweep = function (node) {
    var type = apply(nodeType, node, []);
    if (type === 1 && apply(matches, node, [FRAMES])) remove(node);
    else if (type === 1) each(apply(inElement, node, [FRAMES]), remove);
    else if (type === 11) each(apply(inFragment, node, [FRAMES]), remove);
  };
  var guard = new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) each(apply(addedNodes, records[r], []), sweep);
  });
  apply(observe, guard, [document, options]);
  Element.prototype.attachShadow = function attachShadow_(init) {
    var own = {
      __proto__: null, mode: init.mode, delegatesFocus: init.delegatesFocus,
      slotAssignment: init.slotAssignment, serializable: init.serializable, clonable: false
    };
    var root = apply(attachShadow, this, [own]);
    apply(observe, guard, [root, options]);
    return root;
  };
})();`;

// Measures the content and reports its height to the frame's parent whenever
// it changes. A frame is sized to the report, so it measures the root's box,
// which follows the content, rather than the viewport, which would follow the
// frame; content that overflows the root counts too. The box is fractional
// and rounded up, so the frame is never a fraction short and never shows a
// scrollbar for it. It reports nothing before the document has loaded: a
// page that navigates its frame while it loads never loads, so it never
// reports, and the client shows it as failed when its time runs out, rather
// than as shown with whatever the frame shows instead. The parent is taken
// before the page runs, so the page cannot shadow it; the page can still lie
// about its height, which sizes only its own frame.
const HEIGHT_REPORTER = `(function(){var p=window.parent,l=-1,ready=false;function s(){if(!ready)return;var r=document.documentElement,h=Math.ceil(Math.max(r.getBoundingClientRect().height,r.scrollHeight>r.clientHeight?r.scrollHeight:0));if(h===l)return;l=h;if(p!==window)p.postMessage({type:${JSON.stringify(VISUAL_HEIGHT_MESSAGE)},height:h},"*");}if(window.ResizeObserver){var o=new ResizeObserver(s);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}window.addEventListener("load",function(){ready=true;s();});})();`;

// The root keeps room for a scrollbar on both sides whether one shows or not.
// Otherwise, where scrollbars take space, a page whose height follows its
// width (a chart scaled to fit) could stay shorter than it is without one:
// shown first in a frame too short for it, it gets a scrollbar, narrows,
// reports the narrower height, and the scrollbar never goes away.
const themeStyle = (appearance: VisualAppearance, palette: Palette | undefined): string => {
  const variables = Object.entries(visualVariables(appearance, palette))
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
  return (
    `:root{color-scheme:${appearance};${variables}}` +
    "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%;scrollbar-gutter:stable both-edges}" +
    "body{margin:0;padding:12px}code,kbd,pre,samp{font-family:var(--font-mono)}"
  );
};

/**
 * A bot's page, ready for the client's visual page or `visualShell`: the
 * policy, the theme of `appearance`, the guard and the height reporter, then
 * the page as the bot wrote it. They come before any of the page, so the
 * policy holds from the page's first byte and the page cannot take it back (a
 * second policy of its own could only narrow it), and the guard has run
 * before the page's first script. The page's own `<html>`, `<head>` and
 * doctype join the ones already open. A theme change builds it again.
 *
 * Null when the page's markup holds what the guard could not watch, another
 * document or a declarative shadow root (`visualEscapesGuard`): the client
 * shows that it could not show it.
 */
export const visualDocument = (
  html: string,
  appearance: VisualAppearance,
  palette?: Palette,
): string | null =>
  visualEscapesGuard(html)
    ? null
    : "<!doctype html>" +
      `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<style>${themeStyle(appearance, palette)}</style>` +
      `<script>${PAGE_GUARD}</script>` +
      `<script>${HEIGHT_REPORTER}</script>` +
      html;

// Relays the height the framed document reports, from that frame's window
// alone, to the WebView's bridge, as the two fields `readVisualReport` reads.
// The frame loads once, with the visual; a later load is the frame showing
// something else, which the visual navigated it to (the WebView's error page
// most often, since the policy lets it reach nothing), and the relay says so.
// A visual that reloads itself loads again too, and is counted gone with them.
const HEIGHT_RELAY = `(function(){var f=document.getElementById("visual"),b=window[${JSON.stringify(VISUAL_BRIDGE)}],loads=0;f.addEventListener("load",function(){if(++loads>1&&b)b.postMessage(JSON.stringify({type:${JSON.stringify(VISUAL_GONE_MESSAGE)}}));});window.addEventListener("message",function(e){var d=e.data;if(e.source!==f.contentWindow||!b||d===null||typeof d!=="object")return;b.postMessage(JSON.stringify({type:d.type,height:d.height}));});})();`;

/** `text` as a double-quoted attribute's value: the parser gives back `text`. */
const attributeValue = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The page a WebView loads to show `document`, as `visualDocument` builds it.
 * A WebView loads its page unsandboxed (a policy's `sandbox` in a `<meta>`
 * does nothing), so a frame the visual added would share its origin, and the
 * visual could take that frame's built-ins, which the guard never touched.
 * Here the document runs in a frame sandboxed with scripts only, as on the
 * web, and this page, under the visual's policy too, passes its height to
 * the app's bridge (`VISUAL_BRIDGE`), and that the frame left the visual. The frame fills the page; the app sizes
 * the WebView to the height.
 */
export const visualShell = (document: string): string =>
  "<!doctype html>" +
  `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>" +
  `<iframe id="visual" sandbox="${VISUAL_FRAME_SANDBOX}" srcdoc="${attributeValue(document)}"></iframe>` +
  `<script>${HEIGHT_RELAY}</script>`;

const HeightMessage = Schema.Struct({
  type: Schema.Literal(VISUAL_HEIGHT_MESSAGE),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
});
const decodeHeightMessage = Schema.decodeUnknownOption(
  Schema.Union([HeightMessage, Schema.fromJsonString(HeightMessage)]),
  { onExcessProperty: "error" },
);
const GoneMessage = Schema.Struct({ type: Schema.Literal(VISUAL_GONE_MESSAGE) });
const decodeGoneMessage = Schema.decodeUnknownOption(Schema.fromJsonString(GoneMessage), {
  onExcessProperty: "error",
});

/**
 * The height a visual reports, fitted to what a frame is drawn at inline, or
 * null for anything else it sends. Only `{type: "j3-visual-height", height}`
 * is read, as an object or as its JSON. The caller checks that it came from
 * the visual's own frame; a page can lie about its height, which only sizes
 * its own frame.
 */
export const readVisualHeight = (data: unknown): number | null =>
  Option.match(decodeHeightMessage(data), {
    onNone: () => null,
    onSome: ({ height }) => clampVisualHeight(height),
  });

/** What `visualShell` passes to the app: the visual's height, or that its frame left it. */
export type VisualReport =
  | { readonly _tag: "height"; readonly height: number }
  | { readonly _tag: "gone" };

/**
 * What a WebView's page for a visual (`visualShell`) passes to the app, as
 * the JSON its bridge takes, or null for anything else: the height as
 * `readVisualHeight` reads it, or `{type: "j3-visual-gone"}` once the frame
 * shows something other than the visual. The visual can reach the bridge
 * too, so it can say either, which changes only its own view.
 */
export const readVisualReport = (data: unknown): VisualReport | null => {
  const height = readVisualHeight(data);
  if (height !== null) return { _tag: "height", height };
  return Option.isSome(decodeGoneMessage(data)) ? { _tag: "gone" } : null;
};
