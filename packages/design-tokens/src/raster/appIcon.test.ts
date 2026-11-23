// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { iconArt, type IconArt } from "../appIconArt.ts";
import { renderAppIcon, renderTrayIcon } from "./appIcon.ts";
import { readPng } from "./readPng.ts";

/** Each pixel's alpha of a PNG `renderAppIcon` wrote. */
const alphaOf = (png: Uint8Array<ArrayBuffer>) => {
  const { rgba } = readPng(png);
  return (x: number, y: number) => rgba(x, y)[3];
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
    );
    // Outside the plate: its margin, and its rounded corner.
    expect([alpha(2, 32), alpha(32, 61), alpha(9, 9)]).toEqual([0, 0, 0]);
    // Inside it, where the body runs on to the edge.
    expect([alpha(10, 32), alpha(32, 53)]).toEqual([255, 255]);
  });

  it("leaves the art whole past its frame where there is no plate", () => {
    const alpha = alphaOf(
      renderAppIcon({ size, plate: { kind: "none" }, framing: "plate", width: 0.5 }, close),
    );
    // The body carries on past the frame, which spans 16 to 48 px, to its own edge.
    expect([alpha(8, 32), alpha(32, 50)]).toEqual([255, 255]);
  });
});

describe("renderTrayIcon", () => {
  // A short antenna on a wide body, and a tall one on a narrow body whose own light is lit.
  const arts: ReadonlyArray<readonly [string, IconArt]> = [
    ["a dome", { ...iconArt, avatar: { shape: "dome", color: "tangerine" } }],
    [
      "a bean with its light lit",
      {
        ...iconArt,
        avatar: { shape: "bean", color: "cobalt" },
        face: { ...iconArt.face, antennaLength: 21, light: "waiting", signal: "ping" },
      },
    ],
  ];
  const size = 16;

  describe.each(arts)("drawn from %s", (_, art) => {
    it.each(["light", "dark"] as const)(
      "changes far more than the tip's color when something waits, in %s",
      (theme) => {
        const idle = readPng(renderTrayIcon(false, theme, size, art)).rgba;
        const attention = readPng(renderTrayIcon(true, theme, size, art)).rgba;
        let changed = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const before = idle(x, y);
            const after = attention(x, y);
            if (before.some((value, c) => Math.abs(value - (after[c] ?? 0)) > 24)) changed++;
          }
        }
        // Recoloring the light alone changed about a twentieth of the icon.
        expect(changed / (size * size)).toBeGreaterThan(0.1);
      },
    );

    it("keeps the attention form's light and ring inside the icon", () => {
      const { rgba } = readPng(renderTrayIcon(true, "light", size, art));
      for (let x = 0; x < size; x++) expect(rgba(x, 0)[3]).toBe(0);
    });
  });
});
