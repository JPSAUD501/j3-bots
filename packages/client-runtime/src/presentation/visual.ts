// SPDX-License-Identifier: AGPL-3.0-or-later
import { clampVisualHeight } from "@j3-bots/contracts";
import { fonts, radii, visualColors } from "@j3-bots/design-tokens";
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
 * The page's own scripts and styles run, inline only; images and fonts only
 * from `data:` or `blob:` URLs. Nothing reaches the network: no fetch, no
 * remote script, style, font or image, no frame, no form, no `<base>`. So a
 * visual can neither report that it was seen nor send anything it reads.
 */
export const VISUAL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The web's `sandbox` for a visual's frame: scripts, and nothing else. Never
 * `allow-same-origin`, which would give the page the client's origin, its
 * storage and its session; never top navigation, popups or forms.
 */
export const VISUAL_FRAME_SANDBOX = "allow-scripts";

/** The one message a client takes from a visual: the height its content needs. */
export const VISUAL_HEIGHT_MESSAGE = "j3-visual-height";

// Measures the content and reports its height whenever it changes. A frame is
// sized to the report, so it measures the root's box, which follows the
// content, rather than the viewport, which would follow the frame; content
// that overflows the root counts too. On Android the WebView's bridge carries
// it as a string; in a frame it goes to the parent.
const HEIGHT_REPORTER = `(function(){var n=window.ReactNativeWebView,l=-1;function s(){var r=document.documentElement,h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h===l)return;l=h;var m={type:${JSON.stringify(VISUAL_HEIGHT_MESSAGE)},height:h};if(n&&typeof n.postMessage==="function")n.postMessage(JSON.stringify(m));else if(window.parent!==window)window.parent.postMessage(m,"*");}if(window.ResizeObserver){var o=new ResizeObserver(s);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);s();});}window.addEventListener("load",s);})();`;

const themeStyle = (appearance: VisualAppearance): string => {
  const variables = Object.entries(visualColors(appearance))
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
  return (
    `:root{color-scheme:${appearance};${variables}--font-sans:${fonts.sans};--font-mono:${fonts.mono};--radius:${radii.md}px}` +
    "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%}" +
    "body{margin:0;padding:12px}code,kbd,pre,samp{font-family:var(--font-mono)}"
  );
};

/**
 * A bot's page, ready for a frame's `srcdoc` or a WebView's `html`: the
 * policy, the theme of `appearance` and the height reporter, then the page as
 * the bot wrote it. They come before any of the page, so the policy holds
 * from the page's first byte and the page cannot take it back: a second
 * policy of its own could only narrow it. The page's own `<html>`, `<head>`
 * and doctype join the ones already open. A theme change builds it again.
 */
export const visualDocument = (html: string, appearance: VisualAppearance): string =>
  "<!doctype html>" +
  `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<style>${themeStyle(appearance)}</style>` +
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
