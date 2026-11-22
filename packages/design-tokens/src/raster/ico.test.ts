// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { desktopIcon, renderAppIcon } from "./appIcon.ts";
import { icoFile } from "./ico.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Each image an icon file's directory names: its side and the PNG's own width, read where the entry points. */
const readDirectory = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: view.getUint16(4, true) }, (_, i) => {
    const entry = 6 + 16 * i;
    const side = view.getUint8(entry) || 256;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    const png = bytes.subarray(offset, offset + length);
    return {
      side,
      signed: PNG_SIGNATURE.every((byte, k) => png[k] === byte),
      // IHDR's width, right after the signature and the chunk's length and type.
      width: new DataView(png.buffer, png.byteOffset).getUint32(16),
      whole: offset + length <= bytes.length,
    };
  });
};

describe("icoFile", () => {
  it("names each image at its side and points at that image's PNG", () => {
    const sizes = [16, 48, 256];
    const file = icoFile(sizes.map((size) => ({ size, png: renderAppIcon(desktopIcon(size)) })));
    expect(readDirectory(file)).toEqual(
      sizes.map((size) => ({ side: size, signed: true, width: size, whole: true })),
    );
  });

  it("refuses a side its directory cannot name", () => {
    expect(() => icoFile([{ size: 512, png: renderAppIcon(desktopIcon(512)) }])).toThrow(
      RangeError,
    );
  });
});
