// SPDX-License-Identifier: AGPL-3.0-or-later
import { pagePoint } from "@j3-bots/client-runtime/presentation";
import { describe, expect, it } from "vite-plus/test";
import { drawnRect, fitted, keptInView, NO_ZOOM, pinched } from "./zoom.ts";

// A 1280×800 page on a phone 400 points wide, with 600 points for the picture.
const view = { width: 400, height: 600 };
const page = { width: 1280, height: 800 };
const picture = fitted(view, page);

describe("the viewer's zoom", () => {
  it("fits the page to the width, at the top", () => {
    expect(picture).toEqual({ width: 400, height: 250 });
    expect(keptInView(NO_ZOOM, picture, view)).toEqual(NO_ZOOM);
  });

  it("keeps the page point between the fingers under them as they spread", () => {
    const from = [
      { x: 150, y: 100 },
      { x: 250, y: 100 },
    ] as const;
    const to = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ] as const;
    const zoom = pinched(NO_ZOOM, from, to);
    expect(zoom.scale).toBe(2);
    const between = { x: 200, y: 100 };
    expect(pagePoint(between, drawnRect(picture, zoom), page)).toEqual(
      pagePoint(between, drawnRect(picture, NO_ZOOM), page),
    );
  });

  it("never zooms out past the fitted width, nor in past four times it", () => {
    const close = [
      { x: 190, y: 100 },
      { x: 210, y: 100 },
    ] as const;
    const apart = [
      { x: 0, y: 100 },
      { x: 400, y: 100 },
    ] as const;
    expect(pinched(NO_ZOOM, apart, close).scale).toBe(1);
    expect(pinched(NO_ZOOM, close, apart).scale).toBe(4);
  });

  it("never leaves a gap at an edge the picture can cover", () => {
    const zoom = keptInView({ scale: 2, x: 50, y: -900 }, picture, view);
    // 800 by 500: wider than the view, shorter than it.
    expect(zoom).toEqual({ scale: 2, x: 0, y: 0 });
    expect(keptInView({ scale: 4, x: -2000, y: -900 }, picture, view)).toEqual({
      scale: 4,
      x: -1200,
      y: -400,
    });
  });
});
