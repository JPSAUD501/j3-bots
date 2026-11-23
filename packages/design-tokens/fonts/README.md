# Fonts

The three faces J3 Bots draws its interface in, bundled so every client works offline and loads nothing from a font service. Each is licensed under the SIL Open Font License 1.1, whose text, with each family's copyright line, is beside it: [Bricolage Grotesque](LICENSE-BricolageGrotesque.txt), [Instrument Sans](LICENSE-InstrumentSans.txt) and [JetBrains Mono](LICENSE-JetBrainsMono.txt). The OFL lets them be bundled and modified; the files here are modified versions (instanced and subset), and keep the families' names, which none of them reserves.

| File                      | Family              | Weight | Instance              |
| ------------------------- | ------------------- | ------ | --------------------- |
| `BricolageGrotesque-Bold` | Bricolage Grotesque | 700    | `opsz` 36, `wdth` 100 |
| `InstrumentSans-Regular`  | Instrument Sans     | 400    | `wdth` 100            |
| `InstrumentSans-Medium`   | Instrument Sans     | 500    | `wdth` 100            |
| `InstrumentSans-SemiBold` | Instrument Sans     | 600    | `wdth` 100            |
| `JetBrainsMono-Regular`   | JetBrains Mono      | 400    |                       |

Each comes as `.woff2`, which the web client loads, and `.ttf`, which Android embeds at build time (`apps/mobile/app.config.ts`). The `fontFaces` token lists them.

## How they were made

From the variable fonts in [google/fonts](https://github.com/google/fonts) at commit `06bfe0d62a98375cb09c942fa18e68bd32cff057` (`ofl/bricolagegrotesque`, `ofl/instrumentsans`, `ofl/jetbrainsmono`), with fontTools:

1. `fonttools varLib.instancer <font> <axes> --static --update-name-table`, at the instance in the table. A static file holds one optical size, and Bricolage Grotesque is set from 20 to 40 px (the display steps of the type scale), so it is instanced at `opsz` 36, the named size in its STAT table nearest the middle of that range: open enough at 20 px, without the looser spacing of its text sizes at 40.
2. `fonttools subset` to these code points: `U+0000-00FF, U+0100-017F, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0300-0308, U+0327, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD` (Latin, Latin-1, Latin Extended-A, general punctuation where the face has it, arrows), with the default layout features plus `tnum`, `case` and `zero`, `--no-hinting --desubroutinize`, and once more with `--flavor=woff2`.
3. JetBrains Mono drops `calt`, `liga` and `dlig` as well, so code shows exactly as written: `!=` and `->` stay two characters.

A character outside the subset, as in a bot's name in another script, is drawn in the platform's own font.

## In a release

`package.json` here is not a workspace package. It names the fonts and their license, so the release's third-party notices (`scripts/build-release.ts`) list them with the license files beside them, as they list any package a bundle holds.
