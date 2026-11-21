// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/design-tokens/raster`: avatars as PNG images. Kept apart from the
 * package's root, so a client that only reads the tokens and draws avatars
 * with its own renderer never loads the PNG encoder.
 */
export { parseColor, toSrgb8, type LinearRgb } from "../color.ts";
export { drawAvatar, renderStillAvatar, type AvatarBox } from "./avatarRaster.ts";
export { Canvas, type Rgb } from "./canvas.ts";
