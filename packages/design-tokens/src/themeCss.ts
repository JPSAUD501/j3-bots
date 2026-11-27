// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A theme's custom styles (decision 0104): what they may reach, and what
 * they may not do. Only the web client and the desktop app apply them; the
 * Android app draws with no CSS and says so where a theme is chosen.
 */

/** The most characters a theme's `css` holds: what fits one `theme_save` call with the rest of the theme. */
export const THEME_CSS_MAX_LENGTH = 8_000;

/**
 * The selectors theme CSS may rely on. Every other class name is a utility
 * that changes between releases. A web test fails when a `data-slot` of
 * these leaves the source, so a theme written against them keeps working;
 * a dialog is found by its ARIA role, which every dialog has.
 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-slot="roster"]', styles: "the list of bots and rooms" },
  { selector: '[data-slot="roster-row"]', styles: "one bot or room in the list" },
  {
    selector: '[data-slot="conversation"]',
    styles: "the conversation's area, behind the messages",
  },
  { selector: '[data-slot="conversation-header"]', styles: "the conversation's header" },
  { selector: '[data-slot="timeline"]', styles: "the scrolling list of messages" },
  {
    selector: '[data-slot="message"]',
    styles: 'one message; `[data-author="operator"]` or `[data-author="bot"]` says whose',
  },
  { selector: '[data-slot="bubble"]', styles: "a message's bubble" },
  { selector: '[data-slot="composer"]', styles: "the box where the person writes" },
  { selector: '[data-slot="details"]', styles: "a bot's or room's details" },
  { selector: '[role="dialog"]', styles: "a dialog" },
  { selector: '[data-slot="menu-popup"]', styles: "a menu" },
  { selector: '[data-slot="button"]', styles: "a button" },
  { selector: '[data-slot="switch"]', styles: "a switch" },
] as const;

/** The variable a theme's background image is given in, on the page's root. */
export const THEME_BACKGROUND_VARIABLE = "--theme-background-image";

/**
 * Why `css` cannot be a theme's, or null. Theme CSS never loads a file: a
 * remote image or font would tell a third party when the app is open, and
 * what is on screen through selectors. So it refuses `@import`, `url()`
 * except `#id`, `image-set()` and `src()`; and backslashes, since an escape
 * can spell any of those past a text check. Nor does anything in it move on
 * its own, which would repaint the app frame after frame: no `@keyframes` or
 * `animation`, and no `data:` image, which may be an animated one. The
 * background image comes through `var(--theme-background-image)`, which J3
 * Bots fills with a still image.
 *
 * The checks read the CSS as the browser does: with its comments taken out,
 * since the browser reads `animation` with a comment before its colon as
 * `animation`; and with the strings left whole, so a comment's mark inside
 * one hides nothing.
 */
export function themeCssProblem(given: string): string | null {
  if (given.length > THEME_CSS_MAX_LENGTH) {
    return `\`css\` holds at most ${THEME_CSS_MAX_LENGTH} characters.`;
  }
  if (given.includes("\\")) return "`css` cannot hold a backslash: escapes are not allowed.";
  const css = withoutComments(given);
  if (/@import/i.test(css)) return "`css` cannot use @import: theme CSS loads no file.";
  if (/\b(?:image-set|src)\s*\(/i.test(css)) {
    return "`css` cannot use image-set() or src(): theme CSS loads no file.";
  }
  // A property is a word no letter, digit or hyphen comes right before, its
  // vendor's prefix included: `-webkit-animation` animates as `animation` does.
  if (/@(?:-[a-z]+-)?keyframes\b|(?<![\w-])(?:-[a-z]+-)?animation(?:-[a-z-]+)?\s*:/i.test(css)) {
    return "`css` cannot animate: no @keyframes or animation, since nothing in a theme moves on its own.";
  }
  for (const match of css.matchAll(/url\s*\(\s*(["']?)\s*([^"')\s]*)/gi)) {
    const address = match[2] ?? "";
    if (!address.startsWith("#")) {
      return `\`css\` cannot load \`${address || "a file"}\`: url() takes only #id. Use var(${THEME_BACKGROUND_VARIABLE}) for the theme's background image, and gradients for patterns.`;
    }
  }
  return null;
}

/**
 * `css` with each comment as one space, as the browser reads it. A string
 * runs to its closing quote or the end of its line; with no backslash in
 * `css`, nothing escapes either.
 */
function withoutComments(css: string): string {
  let read = "";
  let at = 0;
  while (at < css.length) {
    const char = css[at] ?? "";
    if (char === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2);
      read += " ";
      at = end === -1 ? css.length : end + 2;
    } else if (char === '"' || char === "'") {
      let end = at + 1;
      while (end < css.length && css[end] !== char && css[end] !== "\n") end += 1;
      read += css.slice(at, end + 1);
      at = end + 1;
    } else {
      read += char;
      at += 1;
    }
  }
  return read;
}
