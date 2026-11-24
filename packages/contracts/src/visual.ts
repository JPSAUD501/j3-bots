// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

// A visual is a page a bot built (a chart, a table, a diagram, a mockup) that
// clients render inside the conversation, in a sandboxed frame with no network.
// docs/architecture/clients.md, "Visuals", says how; docs/architecture/security.md
// says why the frame is shut the way it is.

/** The most a visual's page may weigh, as UTF-8. */
export const MAX_VISUAL_BYTES = 512 * 1024;

/** The shortest and tallest a visual's frame is drawn inline, in CSS pixels. */
export const MIN_VISUAL_HEIGHT = 80;
export const MAX_VISUAL_HEIGHT = 2_000;

/** The longest title a visual has. */
export const MAX_VISUAL_TITLE_LENGTH = 200;

/**
 * What a visual may load and run: its own inline scripts and styles, images
 * and fonts from `data:` or `blob:` URLs, and nothing from the network: no
 * fetch, no remote script, style, font or image, no frame, no form, no
 * `<base>`. So a visual can neither report that it was seen nor send anything
 * it reads.
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
 * The page of the web client's build a visual is drawn in, on the client's
 * own origin. Its document has a policy of its own, which a `srcdoc` frame
 * would not: it would take the client's, whose scripts are only its own.
 */
export const VISUAL_FRAME_PATH = "/visual-frame.html";

/**
 * The policy whoever serves `VISUAL_FRAME_PATH` sends with it: a visual's,
 * plus `sandbox allow-scripts`, so the page has an opaque origin wherever it
 * is opened, even on its own, and only the client's own pages may frame it.
 */
export const VISUAL_FRAME_POLICY = `${VISUAL_CONTENT_SECURITY_POLICY}; sandbox allow-scripts; frame-ancestors 'self'`;

/**
 * Whether a page's markup holds what the guard a visual's document runs
 * first could not watch, so the page is not shown:
 *
 * - another document: an `<iframe>`, `<frame>`, `<object>` or `<embed>` start
 *   tag, the only way markup makes one. A nested document is a realm of its
 *   own, with everything the guard took from the page.
 * - a declarative shadow root: a `shadowrootmode` attribute, or the older
 *   `shadowroot`. The parser attaches it without `attachShadow`, so the guard
 *   never observes it, and a frame a script later adds inside it would stay.
 *
 * It reads text, not a parsed document, so a tag or attribute in a comment or
 * in a script's string counts too.
 */
export const visualEscapesGuard = (html: string): boolean =>
  EMBEDDED_DOCUMENT.test(html) || DECLARATIVE_SHADOW_ROOT.test(html);

// A start tag's name ends at whitespace, `/` or `>`; the tokenizer lowercases
// only ASCII letters, so no other spelling makes one of these elements.
const EMBEDDED_DOCUMENT = /<(?:iframe|frame|object|embed)[\s/>]/i;
// An attribute's name starts after whitespace, after the `/` that follows a
// tag's name, or right after a quoted value; `=` gives it the value a root
// needs. A property read in a script, such as `.shadowRoot`, follows a `.`.
const DECLARATIVE_SHADOW_ROOT = /[\s/"']shadowroot(?:mode)?\s*=/i;

const utf8 = new TextEncoder();

/**
 * A visual's page: an HTML document as the bot wrote it, never blank, well
 * formed (no lone surrogate, so it is exactly a UTF-8 text) and at most
 * `MAX_VISUAL_BYTES` as UTF-8. Clients wrap it before they render it; nothing
 * ever runs it anywhere else.
 */
export const VisualHtml = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.makeFilter(
    (html: string) => html.isWellFormed() || "a page that is not well-formed Unicode text",
  ),
  Schema.makeFilter(
    (html: string) =>
      // A UTF-16 unit is one to three UTF-8 bytes: encode only when the length cannot tell.
      (html.length <= MAX_VISUAL_BYTES &&
        (html.length * 3 <= MAX_VISUAL_BYTES || utf8.encode(html).length <= MAX_VISUAL_BYTES)) ||
      `a page of more than ${MAX_VISUAL_BYTES} bytes`,
  ),
);

/** What a visual is called: its caption, and its accessible name. */
export const VisualTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_VISUAL_TITLE_LENGTH),
  Schema.isTrimmed(),
);

/** The height a frame starts at, before the page reports its own. */
export const VisualHeight = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_VISUAL_HEIGHT, maximum: MAX_VISUAL_HEIGHT }),
);

/** Fits a height a page reports into what a frame is drawn at inline. */
export const clampVisualHeight = (height: number): number =>
  Math.min(MAX_VISUAL_HEIGHT, Math.max(MIN_VISUAL_HEIGHT, Math.ceil(height)));

/**
 * A page a bot showed. `height` is the height the bot measured it at, which a
 * frame starts at until the page reports its own; null when the bot gave none.
 */
export const Visual = Schema.Struct({
  title: VisualTitle,
  html: VisualHtml,
  height: Schema.NullOr(VisualHeight),
});
export type Visual = typeof Visual.Type;
