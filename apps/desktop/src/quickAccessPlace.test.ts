// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  cornerOffset,
  defaultOffset,
  type KeptPlace,
  placeOn,
  quickAccessBounds,
  quickAccessSize,
  shortcutStep,
  withPlace,
} from "./quickAccessPlace.ts";

const laptop = { x: 0, y: 0, width: 1440, height: 860 };
const monitor = { x: 1440, y: -200, width: 2560, height: 1400 };
const size = quickAccessSize(false);

describe("what the global shortcut does", () => {
  const hidden = { available: true, visible: false, focused: false, leaving: false };
  const open = { available: true, visible: true, focused: true, leaving: false };

  it("opens quick access, and closes it when pressed again", () => {
    assert.strictEqual(shortcutStep(hidden), "open");
    assert.strictEqual(shortcutStep(open), "leave");
  });

  it("shows the main window while there is no primary bot to show, or no server reached", () => {
    assert.strictEqual(shortcutStep({ ...hidden, available: false }), "show-main");
  });

  it("brings back a quick access put aside, or on its way out, rather than close it", () => {
    assert.strictEqual(shortcutStep({ ...open, focused: false }), "return");
    assert.strictEqual(shortcutStep({ ...open, leaving: true }), "return");
  });

  it("still closes one whose server went away while it was open", () => {
    assert.strictEqual(shortcutStep({ ...open, available: false }), "leave");
  });
});

describe("where quick access stands", () => {
  it("opens in the bottom-right corner of the display it is asked on", () => {
    assert.deepStrictEqual(quickAccessBounds(laptop, size, defaultOffset(false)), {
      x: 1440 - size.width,
      y: 860 - size.height,
      ...size,
    });
    assert.deepStrictEqual(quickAccessBounds(monitor, size, defaultOffset(false)), {
      x: 1440 + 2560 - size.width,
      y: -200 + 1400 - size.height,
      ...size,
    });
  });

  it("comes back where it was dragged to, on the display it was dragged on", () => {
    const dragged = { x: 1500, y: 100, ...size };
    const kept = cornerOffset(monitor, dragged);
    assert.deepStrictEqual(quickAccessBounds(monitor, size, kept), dragged);
  });

  it("stays whole on a display that got smaller since it was placed", () => {
    // Left by the top-left corner of the monitor, then asked for on the laptop.
    const kept = cornerOffset(monitor, { x: 1440, y: -200, ...size });
    assert.deepStrictEqual(quickAccessBounds(laptop, size, kept), { x: 0, y: 0, ...size });
    // Dragged half off the right edge.
    const off = cornerOffset(laptop, { x: 1300, y: 300, ...size });
    assert.strictEqual(quickAccessBounds(laptop, size, off).x, 1440 - size.width);
  });

  it("shrinks to a work area shorter than it is", () => {
    const short = { x: 0, y: 30, width: 1024, height: 500 };
    assert.deepStrictEqual(quickAccessBounds(short, size, defaultOffset(false)), {
      x: 1024 - size.width,
      y: 30,
      width: size.width,
      height: 500,
    });
  });

  it("keeps a place per display, and forgets the display left longest ago", () => {
    const here = { right: 10, bottom: 20 };
    let places: ReadonlyArray<KeptPlace> = [];
    for (let display = 1; display <= 9; display++) places = withPlace(places, `${display}`, here);
    const displays = (kept: ReadonlyArray<KeptPlace>) => kept.map((place) => place.display);
    assert.deepStrictEqual(displays(places), ["2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.isNull(placeOn(places, "1"));
    // Put somewhere else on a display it knows: that display is the newest, and none is dropped.
    const moved = withPlace(places, "3", { right: 1, bottom: 2 });
    assert.deepStrictEqual(displays(moved), ["2", "4", "5", "6", "7", "8", "9", "3"]);
    assert.deepStrictEqual(placeOn(moved, "3"), { right: 1, bottom: 2 });
  });
});
