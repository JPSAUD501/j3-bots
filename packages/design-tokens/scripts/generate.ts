// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes what is generated from the tokens: the web stylesheet, the mobile
// theme, and the fonts and icons native builds read. tokens.test.ts and
// nativeIcons.test.ts fail when any of them is stale.
import * as NodeFS from "node:fs";
import { renderFontManifest } from "../src/fontManifest.ts";
import { nativeIconFiles } from "../src/raster/nativeIcons.ts";
import { renderUniwindCss } from "../src/uniwind.ts";
import { renderWebCss } from "../src/web.ts";

NodeFS.writeFileSync(new URL("../generated/web.css", import.meta.url), renderWebCss());
NodeFS.writeFileSync(new URL("../generated/uniwind.css", import.meta.url), renderUniwindCss());
NodeFS.writeFileSync(new URL("../generated/fonts.json", import.meta.url), renderFontManifest());

const icons = new URL("../generated/icons/", import.meta.url);
NodeFS.rmSync(icons, { recursive: true, force: true });
for (const [path, body] of nativeIconFiles) {
  const file = new URL(path, icons);
  NodeFS.mkdirSync(new URL(".", file), { recursive: true });
  NodeFS.writeFileSync(file, body());
}
