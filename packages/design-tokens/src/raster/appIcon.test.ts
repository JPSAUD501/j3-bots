// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { iconArt, type IconArt } from "../appIconArt.ts";
import { renderAppIcon } from "./appIcon.ts";

/** Each pixel's alpha of a PNG `renderAppIcon` wrote, `size` px square. */
const alphaOf = (png: Uint8Array<ArrayBuffer>, size: number) => {
  const view = new DataView(png.buffer, png.byteOffset);
  const idat = 8 + 25;
  const rows = inflateSync(png.subarray(idat + 8, idat + 8 + view.getUint32(idat)));
  // Each row is its filter byte, then four bytes a pixel.
  return (x: number, y: number) => rows[y * (1 + size * 4) + 1 + x * 4 + 3];
};

describe("renderAppIcon", () => {
  // A dome framed so close that its body runs past every edge of the plate.
  const close: IconArt = {
    ...iconArt,
    avatar: { shape: "dome", color: "teal" },
    frame: { x: 30, y: 50, size: 40 },
  };
  const size = 64;
  const inset = 1 / 8;

  it("cuts what the art frames past a rounded plate off at the plate's edge", () => {
    const alpha = alphaOf(
      renderAppIcon(
        { size, plate: { kind: "rounded", inset }, framing: "plate", width: 1 - 2 * inset },
        close,
      ),
      size,
    );
    // Outside the plate: its margin, and its rounded corner.
    expect([alpha(2, 32), alpha(32, 61), alpha(9, 9)]).toEqual([0, 0, 0]);
    // Inside it, where the body runs on to the edge.
    expect([alpha(10, 32), alpha(32, 53)]).toEqual([255, 255]);
  });

  it("leaves the art whole past its frame where there is no plate", () => {
    const alpha = alphaOf(
      renderAppIcon({ size, plate: { kind: "none" }, framing: "plate", width: 0.5 }, close),
      size,
    );
    // The body carries on past the frame, which spans 16 to 48 px, to its own edge.
    expect([alpha(8, 32), alpha(32, 50)]).toEqual([255, 255]);
  });
});
