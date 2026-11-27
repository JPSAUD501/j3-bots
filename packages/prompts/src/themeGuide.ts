// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_THEME_BACKGROUND_SIZE } from "@j3-bots/contracts";
import {
  THEME_BACKGROUND_VARIABLE,
  THEME_CSS_HOOKS,
  THEME_CSS_MAX_LENGTH,
  THEME_ROLE_USES,
  THEME_ROLES,
} from "@j3-bots/design-tokens";

/**
 * What a bot reads to make a theme, which `theme_read` answers with: the
 * format, the roles, the rules the server holds a theme to, and what custom
 * CSS may reach. Built from the design tokens' own lists, so it names the
 * roles and selectors the release has.
 */
export const THEME_GUIDE = [
  "A theme restyles J3 Bots for your user: its canvases, lines, text, bubbles and accent, in a light and a dark appearance. Your user picks light, dark or the system's on top of it.",
  "",
  "Colors: `canvas` and `accent` (#rrggbb) derive every role of both appearances. Give one of each for both appearances, or `{light, dark}` for each; a single canvas keeps its hue and moves to each appearance's lightness. `colors` overrides single roles in both appearances, and `variants.light` or `variants.dark` in one. Prefer the seeds; override only what the look needs. A role takes #rrggbb or oklch(L C H), with an optional `/ alpha`.",
  "Roles:",
  ...THEME_ROLES.map((role) => `- ${role}: ${THEME_ROLE_USES[role]}`),
  "",
  "Not roles, and kept in every theme: the bots' own colors, which are who they are, and the colors that say a bot needs your user or is blocked. J3 Bots moves their shade to stay readable on your canvas and apart from your accent.",
  "Contrast: text reaches 4.5:1 on what it sits on, marks and switch tracks 3:1, and every bot's color 3:1 on every canvas. A color that falls short is moved in lightness, and `theme_save` says what moved; a theme that cannot keep the rules is refused with the reason.",
  "",
  `CSS: \`css\` (at most ${THEME_CSS_MAX_LENGTH} characters) is applied after the app's own styles, on the web and in the desktop app only; the Android app ignores it. Use \`.dark\` or \`:root:not(.dark)\` for one appearance, and !important where the app's rule is more specific. It loads no file and moves nothing on its own: no @import, image-set() or src(), url() only with #id (gradients make patterns), no @keyframes or animation, and no backslash.`,
  "Stable selectors (other class names change between releases):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "",
  `Background: \`background\` is an image in your workspace (JPEG, PNG or WebP, at most ${MAX_THEME_BACKGROUND_SIZE / (1024 * 1024)} MB), shown behind the conversation on every device, under a veil of the canvas so text stays readable. In CSS it is \`var(${THEME_BACKGROUND_VARIABLE})\`. An animated image is refused.`,
  "",
  "Nothing in a theme moves on its own, which would drain batteries: CSS with @keyframes or animation, and an animated image, are refused.",
  "Saving never applies a theme. Offer it with `say`'s `offer: {apply_theme: <id>}`: your user presses Apply theme on the device they want it on. You cannot see the result: describe what you made and ask how it looks.",
].join("\n");
