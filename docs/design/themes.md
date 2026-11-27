# Themes

A theme restyles J3 Bots for the operator: its canvases, lines, text, bubbles and accent, in a light and a dark appearance ([decision 0104](../decisions/0104-a-theme-is-data-two-colors-and-the-person-applies-it.md)). This page says how a theme is made, how it is held to the same contrast as the stock tokens, and how each client draws one. The code is `packages/design-tokens/src/theme.ts` (derivation and checks), `builtInThemes.ts` (the seven built-ins) and `themeCss.ts` (custom CSS).

## A theme is data

```ts
interface ThemeDefinition {
  name: string;
  description?: string;
  canvas: ThemeSeed;        // "#rrggbb", or { light, dark }
  accent: ThemeSeed;
  colors?: Record<role, color>;                      // both appearances
  variants?: { light?: Record<…>; dark?: Record<…> }; // one appearance
  css?: string;             // web and desktop only
}
```

The built-ins, the operator's form and a bot's `theme_save` all make one. The server keeps definitions, never palettes: every client derives both palettes from a definition with the same function, `resolveTheme`, so a theme looks the same everywhere and a later release can improve the derivation without rewriting saved themes. A theme's background image is kept beside it on the server ([Server: themes](../architecture/server.md#themes)).

## Roles

A theme sets the interface's roles: `background`, `surface`, `sidebar`, `muted`, `row-hover`, `muted-strong`, `border`, `input`, `foreground`, `muted-foreground`, the operator's and a bot's bubble and their text, `code-background`, `accent`, `accent-foreground` and `control-off`. `THEME_ROLES` and `THEME_ROLE_USES` list them with what each paints; the tool guide a bot reads is built from them.

Two kinds of color are not roles, and stay in every theme:

- **The bots' colors.** A bot's color is who it is, in its face, its bubble's tint and its row. A theme moves nothing of it; it is checked against the theme instead (below).
- **State colors.** `waiting`, `blocked` and `success` keep their meaning. The theme moves only their shade, in lightness and by at most 12° of hue, so each stays readable on the canvases and at least 0.09 apart in OKLab from the accent (`STATE_ACCENT_DISTANCE`), so a theme with an amber accent never makes waiting look like a button.

## Deriving both appearances from two colors

From `canvas` and `accent`, `derivedRoles` places every role in OKLCH, keeping the canvas's hue:

- **A single canvas** is used as it is in the appearance it suits (lightness at most 0.32 for dark, at least 0.9 for light) and, in the other, keeps its hue and some of its chroma at that appearance's usual lightness (0.2 dark, 0.975 light). The bot is told it moved. `{light, dark}` gives each its own, used as given and held to the rules below, which a light canvas given for the dark appearance fails.
- **Canvases** step from the background by small lightness offsets: in dark, the sidebar a little darker, the surface, `muted` and `muted-strong` lighter, each with a little more chroma, so a warm or cool canvas reads as one family; in light, the surface whiter and the rest darker.
- **Lines** in dark are the foreground at 9% and 15% alpha, so they suit any canvas; in light they are the canvas darkened.
- **Text** sits near the ends of lightness with a trace of the canvas's hue.
- **The operator's bubble** takes the accent's hue: dimmed in dark (lightness 0.36, half its chroma), as it is in light.
- **Code** keeps the stock code background.

Then `colors` and `variants` override single roles, and every role is checked.

## Contrast

Every palette `resolveTheme` gives keeps the rules the stock tokens keep (`paletteProblems`, the same as `tokens.test.ts` checks):

- text 4.5:1 on whatever it is drawn on, the bubbles' code blocks included;
- marks (the accent, state colors, switch tracks) 3:1 on every canvas, and the switch's thumb 3:1 on both tracks;
- every bot's color 3:1 on every canvas, and the bot bubble's text 4.5:1 on every bot's tinted bubble.

A role that falls short is moved in lightness, by bisection, until it reaches the rule, and the move is reported as an adjustment: which appearance, which role, from and to, and why, in English. The operator's form says only "Some colors were adjusted a little"; a bot's `theme_save` answer lists each one. A theme where no lightness reaches the rule, such as one whose canvas is a mid gray no bot color reads on, is refused with the reason.

## The built-ins

Palco (the stock look, monochrome and pure black in the dark), Grafite, Oceano, Floresta, Brasa, Lavanda and Papel. Each is a `ThemeDefinition` in `builtInThemes.ts`, in the same format as a saved one. Each keeps every rule in both appearances, its canvas exactly and its accent's hue, and its state colors apart from its accent within 12° of their own hue (`theme.test.ts`). Their names and descriptions are in the interface's language.

## Custom CSS

`css`, at most 8,000 characters, is applied after the app's own styles on a computer, in the browser or the desktop app: where a mouse or a trackpad is the main pointer (`(hover: hover) and (pointer: fine)`). A phone or a tablet in a browser, and the Android app, show a theme's colors, and their Settings say that some themes change more on a computer. It is written against stable hooks (`THEME_CSS_HOOKS`): `data-slot` attributes on the roster, its rows, the conversation, its header, the timeline, a message (with `data-author`), a bubble, the composer, the details panel, menus, buttons and switches, and `[role="dialog"]`. A web test fails when one leaves the interface. Other class names change between releases.

Theme CSS loads nothing and moves nothing on its own (`themeCssProblem`): no `@import`, `image-set()`, `src()` or backslash, `url()` only for `#id`, and no `@keyframes` or `animation`. Transitions stay, since they run only on a change.

Settings never shows a theme's CSS. While it is open, the page holds the theme's own stylesheet off and draws Settings, and everything else, in the theme's colors alone, so whatever a theme's CSS hides or disguises, the person can always see the themes and pick another. ⌘, (Ctrl+, elsewhere) opens Settings, and so does the desktop app's Go menu, for a theme whose CSS hides the button in the roster: which is why the CSS applies only where a keyboard is at hand.

## Background image

A saved theme may carry one still image, JPEG, PNG or WebP of at most 4 MiB, set by a bot from its workspace. Every client draws it behind the conversation, centered and covering it, under a veil of the canvas (`pictureVeil`): at least 84%, and thicker where a picture's whitest or blackest would take a word on the conversation under its contrast, so the rules above hold on any picture. On the web and desktop it is `var(--theme-background-image)` too, for a theme's CSS. An animated image, or one cut short, is refused. A bot only adds themes: a saved theme never changes under a person who applied it, and a deleted theme's id is never used again.

## How a client draws a theme

The theme a device shows is its person's pick, kept on the device, else the server's default, else Palco. A device that picked a saved theme deleted since falls back the same way.

- **Web and desktop.** The page adds two stylesheets over the generated one: the theme's two palettes as the same custom properties, on `:root[data-theme]`, so they win whichever sheet loads last, and after it the theme's own CSS. They are kept in local storage, and `index.html` puts it back before the first paint, so a reload never flashes the stock look; every page of the app, quick access included, follows a change through the storage event. The desktop app is told the theme's canvas and surface with the appearance, and its windows fill with them before the page paints. A visual's document and a connector's app get the theme's palette.
- **Android.** The app hands both palettes to Uniwind as its theme's variables, which repaints without a reload, and keeps them for the next launch.

Switching is a stylesheet or a variable swap: no reload, and nothing redrawn frame after frame.
