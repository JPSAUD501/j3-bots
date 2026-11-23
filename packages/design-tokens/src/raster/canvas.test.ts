// SPDX-License-Identifier: AGPL-3.0-or-later
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { Canvas, coverage, flattenPath } from "./canvas.ts";

const sum = (values: Float32Array) => values.reduce((total, v) => total + v, 0);

describe("coverage", () => {
  it("covers whole pixels inside a shape, and the covered part of an edge pixel", () => {
    const covered = coverage(flattenPath("M1.25 1L3 1L3 2L1.25 2Z"), 4, 3);
    expect(Array.from(covered.subarray(4, 8))).toEqual([0, 0.75, 1, 0]);
    expect(sum(covered.subarray(0, 4)) + sum(covered.subarray(8, 12))).toBe(0);
  });

  it("fills the circle an arc path draws", () => {
    // Two half arcs of radius 46.
    const area = sum(coverage(flattenPath("M50 4A46 46 0 1 1 50 96A46 46 0 1 1 50 4Z"), 100, 100));
    expect(area / (Math.PI * 46 * 46)).toBeCloseTo(1, 2);
  });

  it("fills an outline drawn inside another the same way round, as SVG's nonzero rule does", () => {
    const covered = coverage(flattenPath("M0 0L4 0L4 4L0 4ZM1 1L3 1L3 3L1 3Z"), 4, 4);
    expect(sum(covered)).toBe(16);
  });
});

describe("flattenPath", () => {
  it("follows a cubic curve through its end points, inside its control polygon", () => {
    const [curve] = flattenPath("M0 0C0 10 10 10 10 0");
    const points = curve?.points ?? [];
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 10, y: 0 });
    // Halfway along, a cubic with these control points reaches 3/4 of their height.
    expect(points[points.length >> 1]?.y).toBeCloseTo(7.5, 5);
  });
});

describe("png", () => {
  // Decoded with Node's own zlib, as an image viewer would decode it.
  it("writes chunks with valid checksums whose image data gives back the pixels", () => {
    const canvas = new Canvas(3, 2, [10, 20, 30]);
    canvas.fill(flattenPath("M0 0L1 0L1 1L0 1Z"), [200, 100, 50]);
    const png = canvas.png();
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const view = new DataView(png.buffer);
    const chunks = new Map<string, Uint8Array>();
    for (let at = 8; at < png.length;) {
      const length = view.getUint32(at);
      const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
      expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks.set(type, png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    expect([...chunks.keys()]).toEqual(["IHDR", "IDAT", "IEND"]);

    const header = chunks.get("IHDR") ?? new Uint8Array();
    const headerView = new DataView(header.buffer, header.byteOffset);
    expect([headerView.getUint32(0), headerView.getUint32(4)]).toEqual([3, 2]);

    const rows = inflateSync(chunks.get("IDAT") ?? new Uint8Array());
    const background = [10, 20, 30, 255];
    // Each row starts with its filter type, 0.
    const expected = [0, 200, 100, 50, 255, ...background, ...background, 0];
    expected.push(...background, ...background, ...background);
    expect(Array.from(rows)).toEqual(expected);
  });
});

describe("Canvas", () => {
  it("clears along an open line without clearing what the line encloses", () => {
    const canvas = new Canvas(20, 20, [10, 20, 30]);
    // Three sides of a square: a fill would close it, a stroke follows it only.
    canvas.clearStroke(flattenPath("M4 4L16 4L16 16L4 16"), 2);
    const alpha = (x: number, y: number) => canvas.pixels[(y * 20 + x) * 4 + 3];
    expect([alpha(10, 4), alpha(16, 10), alpha(10, 15)]).toEqual([0, 0, 0]);
    expect([alpha(10, 10), alpha(4, 10), alpha(0, 0)]).toEqual([255, 255, 255]);
  });

  it.each([
    [0, 4],
    [4, -1],
    [2.5, 4],
    [4, Number.NaN],
  ])("refuses sides of %s × %s px", (width, height) => {
    expect(() => new Canvas(width, height)).toThrow(RangeError);
  });

  const line = flattenPath("M2 5L18 5");
  const stroked = (dash?: readonly [number, number]) => {
    const canvas = new Canvas(20, 10);
    canvas.stroke(line, 2, [0, 0, 0], dash === undefined ? {} : { dash });
    return Array.from(canvas.pixels);
  };

  it("strokes a line solid when every length of its dash pattern is zero, as SVG does", () => {
    expect(stroked([0, 0])).toEqual(stroked());
  });

  it("draws a dash of length zero as a dot, the last one at the line's end", () => {
    const dotted = stroked([0, 8]);
    const alpha = (x: number) => dotted[(5 * 20 + x) * 4 + 3];
    // Dots at 2, 10 and 18 along the line, and nothing halfway between them.
    for (const x of [2, 10, 17]) expect(alpha(x)).toBeGreaterThan(0);
    expect([alpha(6), alpha(14)]).toEqual([0, 0]);
  });

  it.each([
    [-1, 2],
    [2, Number.POSITIVE_INFINITY],
    [Number.NaN, 1],
  ])("refuses a dash pattern of %s and %s", (on, off) => {
    expect(() => stroked([on, off])).toThrow(RangeError);
  });
});
