// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  clampVisualHeight,
  VISUAL_CONTENT_SECURITY_POLICY,
  visualEmbedsDocument,
} from "@j3-bots/contracts";
import { visualVariables } from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How every client wraps a bot's visual before it renders it, so the web, the
 * desktop app and Android shut it in the same way. The frame around it is
 * each client's own (`sandbox="allow-scripts"` on the web; an isolated
 * WebView on Android); the document is this one. docs/architecture/security.md,
 * "Visuals", says why each rule is there.
 */

export type VisualAppearance = "light" | "dark";

/**
 * The web's `sandbox` for a visual's frame: scripts, and nothing else. Never
 * `allow-same-origin`, which would give the page the client's origin, its
 * storage and its session; never top navigation, popups or forms.
 */
export const VISUAL_FRAME_SANDBOX = "allow-scripts";

/** The one message a client takes from a visual: the height its content needs. */
export const VISUAL_HEIGHT_MESSAGE = "j3-visual-height";

/**
 * The object an Android WebView puts on a visual's window to take its height:
 * a `postMessage(string)` that receives the message as JSON. Android's side
 * names it with the same literal.
 */
export const VISUAL_BRIDGE = "J3Visual";

// The first script of a visual's document, before any of the page's, shuts
// the ways out a policy does not:
// - WebRTC. No policy Chromium enforces covers it (`connect-src` does not,
//   and it does not know a `webrtc` directive), so a peer connection could
//   reach any address. Every RTC interface is deleted from the page's realm
//   before the page runs, so none of its scripts can make one.
// - Another realm, which would have them all again. A visual holds no nested
//   document: `visualDocument` refuses a page whose markup has one, and this
//   removes every frame a script adds, to the document or to a shadow root,
//   at the next microtask, before the frame's document can load. The ways to
//   parse a declarative shadow root, whose inside this could not see, are
//   deleted, with `document.write`. A nested document is cross-origin to the
//   page in any case (each has an opaque origin of its own), and the policy
//   starts no worker.
// It keeps the built-ins it uses, so the page cannot turn it off by replacing
// them. docs/architecture/security.md, "Visuals", has the proof.
const GUARD = `(function () {
  "use strict";
  var apply = Reflect.apply, drop = Reflect.deleteProperty, describe = Object.getOwnPropertyDescriptor;
  var names = Object.getOwnPropertyNames(window);
  for (var i = 0; i < names.length; i++) if (/^(webkit)?RTC/.test(names[i])) drop(window, names[i]);
  var parsers = [
    [Document.prototype, "open"], [Document.prototype, "write"], [Document.prototype, "writeln"],
    [Document, "parseHTMLUnsafe"], [Element.prototype, "setHTMLUnsafe"], [Element.prototype, "setHTML"],
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
    var root = apply(attachShadow, this, [init]);
    apply(observe, guard, [root, options]);
    return root;
  };
})();`;

// Measures the content and reports its height whenever it changes. A frame is
// sized to the report, so it measures the root's box, which follows the
// content, rather than the viewport, which would follow the frame; content
// that overflows the root counts too. The box is fractional and rounded up,
// so the frame is never a fraction short and never shows a scrollbar for it.
// On Android the WebView's bridge carries it as a string; in a frame it goes
// to the parent. Both are taken before the page runs, so the page cannot
// shadow them; it can still lie about its height, which sizes only its own
// frame.
const HEIGHT_REPORTER = `(function(){var n=window[${JSON.stringify(VISUAL_BRIDGE)}],p=window.parent,l=-1;function s(){var r=document.documentElement,h=Math.ceil(Math.max(r.getBoundingClientRect().height,r.scrollHeight>r.clientHeight?r.scrollHeight:0));if(h===l)return;l=h;var m={type:${JSON.stringify(VISUAL_HEIGHT_MESSAGE)},height:h};if(n&&typeof n.postMessage==="function")n.postMessage(JSON.stringify(m));else if(p!==window)p.postMessage(m,"*");}if(window.ResizeObserver){var o=new ResizeObserver(s);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);s();});}window.addEventListener("load",s);})();`;

const themeStyle = (appearance: VisualAppearance): string => {
  const variables = Object.entries(visualVariables(appearance))
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
  return (
    `:root{color-scheme:${appearance};${variables}}` +
    "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%}" +
    "body{margin:0;padding:12px}code,kbd,pre,samp{font-family:var(--font-mono)}"
  );
};

/**
 * A bot's page, ready for the client's visual page or a WebView's `html`: the
 * policy, the theme of `appearance`, the guard and the height reporter, then
 * the page as the bot wrote it. They come before any of the page, so the
 * policy holds from the page's first byte and the page cannot take it back (a
 * second policy of its own could only narrow it), and the guard has run
 * before the page's first script. The page's own `<html>`, `<head>` and
 * doctype join the ones already open. A theme change builds it again.
 *
 * Null when the page embeds another document, which a visual may not hold:
 * the client shows that it could not show it.
 */
export const visualDocument = (html: string, appearance: VisualAppearance): string | null =>
  visualEmbedsDocument(html)
    ? null
    : "<!doctype html>" +
      `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<style>${themeStyle(appearance)}</style>` +
      `<script>${GUARD}</script>` +
      `<script>${HEIGHT_REPORTER}</script>` +
      html;

const HeightMessage = Schema.Struct({
  type: Schema.Literal(VISUAL_HEIGHT_MESSAGE),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
});
const decodeHeightMessage = Schema.decodeUnknownOption(
  Schema.Union([HeightMessage, Schema.fromJsonString(HeightMessage)]),
  { onExcessProperty: "error" },
);

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
