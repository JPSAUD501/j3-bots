# 0104: A theme is data, made from two colors, and the person applies it

**Status:** Accepted.

## Context

J3 Bots had one look, Palco, in light and dark. The owner asked for themes "as good as T3 Code's", and for bots to be able to make them. T3 Code's theme system (**Read** at `bc0f04d`) is the reference: a theme is data with a canvas and an accent that the rest derives from, single colors that can be overridden in either appearance, custom CSS against stable selectors, a background image, and tools an agent uses to read the format and set a theme. J3 Bots adds what its own clients need: an Android app that draws natively, bots that act for a person who may not be watching, and contrast that must hold whoever made the colors.

## Decision

**A theme is a definition: a name, a `canvas` and an `accent`, optional role overrides (`colors`, and `variants` for one appearance), optional CSS, and, for a saved theme, an optional still background image. Every client derives both palettes from it with one function and holds them to the stock tokens' contrast rules. The theme a device shows is that device's choice, over a default the operator sets for the server. Bots make themes with `theme_read` and `theme_save`; only the person applies one, from the bot's offer under its message. It ships in 0.15.0.**

- **Two colors, every role.** `canvas` and `accent` derive every interface role of both appearances; a single canvas moves to the other appearance's lightness and keeps its hue. [Design: themes](../design/themes.md) gives the offsets. Bot colors and state colors are not theme roles: a bot's color is its identity, and a state keeps its meaning, the theme moving only its shade.
- **Contrast is checked, not trusted.** Text 4.5:1, marks 3:1, every bot's color 3:1 on every canvas, in both appearances. A role that falls short is moved in lightness and reported; a theme that cannot keep the rules is refused with the reason. The operator's form says it adjusted some colors; a bot is told each move.
- **Seven built-ins in the same format.** Palco, Grafite, Oceano, Floresta, Brasa, Lavanda and Papel, each light and dark, the palettes the owner approved. Light, dark or the system's stays a choice of its own, on top of the theme.
- **Per device, over a server default.** A device keeps its person's pick (the web in local storage, Android in its own store); without one it shows the server's default, which the operator sets in Settings and which starts as Palco. A deleted theme sends every device that showed it back to the default.
- **Settings → Appearance** shows every theme as a small live conversation in its colors, the one in use marked; themes bots made say which bot; a saved theme can be deleted, and the operator's own changed. **Create from colors** takes a name, a background and an accent, and draws the theme in light and dark as they change.
- **Custom CSS on the web and desktop only**, against documented `data-slot` hooks, at most 8,000 characters. It loads no file and moves nothing on its own. Settings never shows it, and `Ctrl+,` (`⌘,`) opens Settings besides its button, so a theme can never take away the way to another. The Android app ignores it and says so where themes are picked.
- **Bots make, people apply.** `theme_read` answers the guide (format, roles, rules, hooks), the themes there are and the default; `theme_save` validates and stores a theme, and answers what it adjusted. Saving never applies a theme: the bot offers it with `say`'s `offer: {apply_theme: <id>}`, and the person presses Apply theme on the device they want it on. A bot changes only themes bots made (its own, or any for the primary bot), never the operator's. The prompt says to use these tools when the operator asks for a theme or for colors, and never to apply one silently.
- **No reload, no frame-by-frame work.** Switching swaps one stylesheet on the web and desktop, and Uniwind's variables on Android. Nothing in a theme animates: an animated image and CSS with `@keyframes` or `animation` are refused.
- **Within protocol 11.** A server that keeps themes says so with `themes: true` in the roster snapshot; a client offers saved themes, the form and the default only then, and shows the built-ins either way. The offer's kind is an open literal, so an older client shows the message alone. The server's data is a migration of its own: two tables and a settings column.

## Costs

- **A theme is drawn by each client from the definition**, so a client of an older release draws a saved theme with the derivation it has. A role a later release adds is passed over by an older client.
- **Custom CSS can mislead outside Settings.** Once applied, it can hide a button or show text that is not J3 Bots' own; it is the person's choice to apply, and Settings stays out of its reach.
- **Custom CSS is only as stable as its hooks.** A theme written against class names other than the hooks breaks when the interface changes, with no error. A test keeps the hooks themselves.
- **The background image is in the database**, up to 4 MiB per theme, so it is in every backup and moves with an export. A bot adds a theme only while fewer than 50 are saved.
- **Previews in Settings show colors**, not a theme's CSS.

## Rejected

- **A bot applying its theme.** It would change what the person sees, on every device, while they may be in the middle of something, and nothing in the conversation would say why. The offer keeps the person's yes.
- **Storing palettes.** It fixes a theme to the release that derived it, and lets a stored palette skip the contrast checks.
- **One theme for the whole server.** People use J3 Bots on a phone and a computer, in different light; the server's default covers the common case.
- **CSS on Android.** The app draws natively; translating CSS would be a second renderer with its own gaps.
- **Images as files in the home.** A row is written in the same transaction as its theme, so nothing is left behind when a theme is deleted.
