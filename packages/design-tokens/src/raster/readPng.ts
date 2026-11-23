// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * For tests: a PNG as `Canvas.png()` writes it (8-bit RGBA, one IDAT chunk,
 * no interlacing, no row filters) read back pixel by pixel.
 */
import { unzlibSync } from "fflate";

/** The image's side and each pixel's RGBA, read where `Canvas.png()` puts them. */
export function readPng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The signature, then the header chunk: its length and type, then the width and height.
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idat = 8 + 25;
  const rows = unzlibSync(png.subarray(idat + 8, idat + 8 + view.getUint32(idat)));
  // Each row is its filter byte, then four bytes a pixel.
  const rgba = (x: number, y: number) => {
    const at = y * (1 + width * 4) + 1 + x * 4;
    return Array.from(rows.subarray(at, at + 4));
  };
  return { width, height, rgba };
}
