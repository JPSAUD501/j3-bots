// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web app's icons, drawn from the icon art (`iconArt`) as every
 * platform's icon is, on the canvas color.
 */
import {
  colors,
  ICON_DOT,
  iconArt,
  iconInk,
  layOutIcon,
  type Themed,
} from "@j3-bots/design-tokens";
import { hexColor, renderAppIcon } from "@j3-bots/design-tokens/raster";

/** The light canvas, which the manifest also gives as the splash and theme color. */
export const canvasColor = hexColor(colors.background.light);
export const darkCanvasColor = hexColor(colors.background.dark);

/**
 * A square icon of `size` px on the light canvas, whose row of bots spans
 * `width` of it, centered. A maskable icon keeps its art within the middle
 * 80% circle, so it asks for less width than one shown as is.
 */
export const iconPng = (size: number, width: number) =>
  renderAppIcon({ size, theme: "light", plate: { kind: "square" }, art: "ensemble", width });

/**
 * The same row as a scalable favicon, on no background, in the palette of the
 * theme the browser is in: a tab strip is drawn in it, not in the page's.
 */
export function iconSvg(): string {
  const row = layOutIcon(iconArt.bots, iconArt.gap);
  const groups = row.placed.map(({ bot, left, top }, i) => {
    const k = bot.size / 100;
    return `<g transform="translate(${left} ${top}) scale(${k})"><path class="b${i}" d="${bot.path}"/><circle class="ink" cx="${bot.mark.x}" cy="${bot.mark.y}" r="${ICON_DOT}"/></g>`;
  });
  const fills = (theme: keyof Themed) =>
    [
      ...row.placed.map(({ bot }, i) => `.b${i}{fill:${hexColor(bot.color[theme])}}`),
      `.ink{fill:${hexColor(iconInk[theme])}}`,
    ].join("");
  const style = `<style>${fills("light")}@media (prefers-color-scheme:dark){${fills("dark")}}</style>`;
  // A square viewBox, so the browser does not stretch the row to fill the tab.
  const pad = (row.width - row.height) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-pad} ${row.width} ${row.width}">${style}${groups.join("")}</svg>\n`;
}
