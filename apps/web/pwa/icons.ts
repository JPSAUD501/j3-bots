// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web app's icons, drawn from the ensemble the first-run and pairing
 * screens show (`ensemble`), as every platform's icon is: no art of its own,
 * so changing the avatars or the canvas changes them all.
 */
import {
  avatarMarks,
  avatarShapes,
  botPalette,
  colors,
  ensemble,
  layOutRow,
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
  const row = layOutRow(ensemble.members, ensemble.gap);
  const [dot] = avatarMarks.dot;
  const groups = row.placed.map(({ member, left, top }, i) => {
    const shape = avatarShapes[member.shape];
    const k = member.size / 100;
    return `<g transform="translate(${left} ${top}) scale(${k})"><path class="b${i}" d="${shape.path}"/><circle class="ink" cx="${shape.mark.x}" cy="${shape.mark.y}" r="${dot.r}"/></g>`;
  });
  const fills = (theme: keyof Themed) =>
    [
      ...row.placed.map(
        ({ member }, i) => `.b${i}{fill:${hexColor(botPalette[member.color][theme])}}`,
      ),
      `.ink{fill:${hexColor(colors["avatar-ink"][theme])}}`,
    ].join("");
  const style = `<style>${fills("light")}@media (prefers-color-scheme:dark){${fills("dark")}}</style>`;
  // A square viewBox, so the browser does not stretch the row to fill the tab.
  const pad = (row.width - row.height) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-pad} ${row.width} ${row.width}">${style}${groups.join("")}</svg>\n`;
}
