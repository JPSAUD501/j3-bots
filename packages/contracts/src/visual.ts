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

/** What a visual is called: its accessible name, and all a notification or the roster says of it. */
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
