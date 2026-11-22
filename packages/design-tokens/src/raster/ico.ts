// SPDX-License-Identifier: AGPL-3.0-or-later

/** One image of an icon file: a square PNG `size` px on a side. */
export interface IcoImage {
  readonly size: number;
  readonly png: Uint8Array;
}

const HEADER = 6;
const ENTRY = 16;
/** The largest side an icon file's directory can name. */
const LARGEST = 256;

/**
 * A Windows icon file holding `images`, each kept as the PNG it is (which
 * Windows reads since Vista). Windows draws the one nearest the size it needs,
 * so the taskbar and the title bar get the small-size drawing, not the large
 * one shrunk.
 */
export function icoFile(images: ReadonlyArray<IcoImage>): Uint8Array<ArrayBuffer> {
  const length = images.reduce((sum, { png }) => sum + png.length, HEADER + ENTRY * images.length);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  // Reserved, then type 1 (an icon), then how many images follow.
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = HEADER + ENTRY * images.length;
  images.forEach(({ size, png }, i) => {
    if (!Number.isInteger(size) || size < 1 || size > LARGEST) {
      throw new RangeError(`An icon file holds sides of 1 to ${LARGEST} px, not ${size}.`);
    }
    const entry = HEADER + ENTRY * i;
    // Width and height, where 0 stands for 256; no palette; one plane of 32 bits.
    view.setUint8(entry, size % LARGEST);
    view.setUint8(entry + 1, size % LARGEST);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, png.length, true);
    view.setUint32(entry + 12, offset, true);
    bytes.set(png, offset);
    offset += png.length;
  });
  return bytes;
}
