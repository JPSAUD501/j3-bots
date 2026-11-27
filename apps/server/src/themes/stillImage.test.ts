// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { isAnimated, isWhole } from "./stillImage.ts";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

/** A PNG's signature and chunks, each with its length, type, data and a CRC left at zero. */
const png = (...chunks: ReadonlyArray<readonly [string, number]>) =>
  Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunks.flatMap(([type, length]) => [
      ...u32(length),
      ...ascii(type),
      ...Array<number>(length).fill(0),
      ...u32(0),
    ]),
  ]);

/** A WebP whose first chunk is `chunk`, with `flags` as its first data byte. */
const webp = (chunk: string, flags: number) =>
  Uint8Array.from([
    ...ascii("RIFF"),
    ...le32(22),
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...le32(10),
    flags,
    ...Array<number>(9).fill(0),
  ]);

describe("a theme's background", () => {
  it("is animated when it is an APNG or an animated WebP", () => {
    expect(isAnimated(png(["IHDR", 13], ["acTL", 8], ["IDAT", 4]), "image/png")).toBe(true);
    expect(isAnimated(webp("VP8X", 0x02), "image/webp")).toBe(true);
  });

  it("is still when it is a plain PNG, a WebP without the animation flag, or a JPEG", () => {
    expect(isAnimated(png(["IHDR", 13], ["IDAT", 4], ["IEND", 0]), "image/png")).toBe(false);
    expect(isAnimated(webp("VP8X", 0x10), "image/webp")).toBe(false);
    expect(isAnimated(webp("VP8 ", 0x02), "image/webp")).toBe(false);
    expect(isAnimated(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(false);
  });
});

describe("a theme's background file", () => {
  it("is whole when it ends as its format ends", () => {
    expect(isWhole(png(["IHDR", 13], ["IDAT", 4], ["IEND", 0]), "image/png")).toBe(true);
    expect(
      isWhole(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9, 0]), "image/jpeg"),
    ).toBe(true);
    expect(isWhole(webp("VP8 ", 0), "image/webp")).toBe(true);
  });

  it("is cut short when its end is missing", () => {
    expect(isWhole(png(["IHDR", 13], ["IDAT", 4]), "image/png")).toBe(false);
    expect(isWhole(Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(false);
    expect(isWhole(webp("VP8 ", 0).slice(0, 24), "image/webp")).toBe(false);
  });
});
