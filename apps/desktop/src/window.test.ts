// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { openingBounds } from "./window.ts";

const laptop = { x: 0, y: 0, width: 1440, height: 875 };
const monitor = { x: 1440, y: -200, width: 2560, height: 1400 };

const reopened = (saved: Parameters<typeof openingBounds>[0]) =>
  openingBounds(saved, [laptop, monitor]).bounds;

describe("where the window opens", () => {
  it("opens where it closed while it lies whole on a display", () => {
    assert.deepStrictEqual(
      reopened({ x: 100, y: 50, width: 1000, height: 700, maximized: false }),
      { x: 100, y: 50, width: 1000, height: 700 },
    );
  });

  it("moves onto the display it overlaps most, with its title bar in reach", () => {
    // Mostly on the monitor, its top above the monitor's work area.
    assert.deepStrictEqual(
      reopened({ x: 1300, y: -400, width: 1200, height: 800, maximized: false }),
      { x: 1440, y: -200, width: 1200, height: 800 },
    );
    // Mostly below the laptop's work area, as after a taller display went away.
    assert.deepStrictEqual(
      reopened({ x: 200, y: 700, width: 800, height: 600, maximized: false }),
      { x: 200, y: 275, width: 800, height: 600 },
    );
  });

  it("shrinks to the display's work area when it is larger", () => {
    assert.deepStrictEqual(
      reopened({ x: -50, y: -50, width: 1600, height: 1000, maximized: true }),
      { x: 0, y: 0, width: 1440, height: 875 },
    );
  });

  it("opens at its default size where it overlaps no display", () => {
    const placed = openingBounds({ x: 5000, y: 5000, width: 800, height: 600, maximized: true }, [
      laptop,
    ]);
    assert.deepStrictEqual(placed, { bounds: { width: 1200, height: 800 }, maximized: true });
    assert.deepStrictEqual(openingBounds(null, [laptop]), {
      bounds: { width: 1200, height: 800 },
      maximized: false,
    });
  });
});
