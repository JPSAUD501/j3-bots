// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web app's icons, drawn from the icon art (`iconArt`) as every
 * platform's icon is.
 */
import { colors } from "@j3-bots/design-tokens";
import { desktopIcon, hexColor, icoFile, renderAppIcon } from "@j3-bots/design-tokens/raster";

/** The light canvas, which the manifest also gives as the splash and theme color. */
export const canvasColor = hexColor(colors.background.light);
export const darkCanvasColor = hexColor(colors.background.dark);

/** An icon shown as it is, on its rounded plate, `size` px square. */
export const plateIcon = (size: number) => renderAppIcon(desktopIcon(size));

/**
 * An icon whose outline the system cuts, `size` px square, the plate's frame
 * spanning `width` of it: all of it where only the corners are cut (iOS), and
 * the 80% circle a maskable icon keeps where any mask may be.
 */
export const squareIcon = (size: number, width: number) =>
  renderAppIcon({ size, plate: { kind: "square" }, framing: "plate", width });

/**
 * The favicon: an icon file with each size a tab, a bookmark or a shortcut
 * draws, so the browser takes the small-size drawing, not a large one shrunk.
 * The plate makes it read on a light tab strip and a dark one alike.
 */
export const favicon = () =>
  icoFile([16, 24, 32, 48, 64].map((size) => ({ size, png: plateIcon(size) })));
