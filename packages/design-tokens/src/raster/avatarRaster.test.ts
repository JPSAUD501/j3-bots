// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { avatarFrame, type AvatarFace, avatarViewBox } from "../avatar.ts";
import { avatarEye, botPalette } from "../botPalette.ts";
import { avatarShapeNames } from "../names.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import { colors } from "../tokens.ts";
import { drawAvatar, renderStillAvatar, renderStillRoomAvatar } from "./avatarRaster.ts";
import { Canvas } from "./canvas.ts";
import { readPng } from "./readPng.ts";

/** An idle bot looking straight ahead, as the client runtime's still form draws one. */
const idle: AvatarFace = {
  lidTop: 0,
  lidBottom: 0,
  blink: 0,
  pupil: 6.2,
  gazeX: 0,
  gazeY: 0,
  shut: 0,
  curve: 0,
  roll: 0,
  cheek: 0,
  eyeLift: 0,
  mouth: 0,
  antennaAngle: 8,
  antennaLength: 17,
  lagX: 0,
  lagY: 0,
  lightScale: 1,
  light: "body",
  hop: 0,
  bob: 0,
  tilt: 0,
  breath: 0,
  squash: 0,
  signal: null,
  ring: 0,
  ping: 0,
  pingOpacity: 0,
  arcs: [1, 1],
  dots: [1, 1],
  asleep: false,
};

const rgb = (value: string) => toSrgb8(parseColor(value));
const near = (pixel: ArrayLike<number>, color: ArrayLike<number>) =>
  Math.hypot(...[0, 1, 2].map((c) => (pixel[c] ?? 0) - (color[c] ?? 0))) < 12;
const pixelsOf = (canvas: Canvas) =>
  Array.from({ length: canvas.width * canvas.height }, (_, i) => ({
    x: i % canvas.width,
    y: Math.floor(i / canvas.width),
    rgba: canvas.pixels.subarray(i * 4, i * 4 + 4),
  }));

describe.each(["light", "dark"] as const)("a %s still avatar", (theme) => {
  it.each(avatarShapeNames)("%s at 24 px stays inside its box and shows its eye", (shape) => {
    const margin = 6;
    const size = 24;
    const canvas = new Canvas(size + 2 * margin, size + 2 * margin);
    drawAvatar(canvas, { shape, color: "cobalt" }, idle, theme, { x: margin, y: margin, size });
    const drawn = pixelsOf(canvas).filter((p) => (p.rgba[3] ?? 0) > 0);
    for (const { x, y } of drawn) {
      expect(x >= margin && x < margin + size && y >= margin && y < margin + size).toBe(true);
    }
    expect(drawn.some((p) => near(p.rgba, rgb(avatarEye.pupil)))).toBe(true);
    expect(drawn.some((p) => near(p.rgba, rgb(avatarEye.lens)))).toBe(true);
  });
});

describe("a still avatar at 96 px", () => {
  const draw = (face: AvatarFace) => {
    const canvas = new Canvas(96, 96);
    drawAvatar(canvas, { shape: "dome", color: "teal" }, face, "light", { x: 0, y: 0, size: 96 });
    return canvas;
  };
  const at = (canvas: Canvas, x: number, y: number) =>
    canvas.pixels.subarray(
      (Math.floor(y) * 96 + Math.floor(x)) * 4,
      (Math.floor(y) * 96 + Math.floor(x)) * 4 + 4,
    );
  const toPx = (p: { x: number; y: number }) => ({
    x: ((p.x - avatarViewBox.x) * 96) / avatarViewBox.size,
    y: ((p.y - avatarViewBox.y) * 96) / avatarViewBox.size,
  });

  it("lights its antenna's tip in the color its state names", () => {
    const face = { ...idle, light: "waiting" as const };
    const tip = toPx(avatarFrame("dome", face, 96).light);
    expect(near(at(draw(face), tip.x, tip.y), rgb(colors.waiting.light))).toBe(true);
    expect(near(at(draw(idle), tip.x, tip.y), rgb(botPalette.teal.light))).toBe(true);
  });

  it("clears a band of whatever lies under a blocked bot's light, so it stands apart", () => {
    // The blocked pose: the eye shut and the antenna slumped, its lit tip on the body.
    const blocked = {
      ...idle,
      shut: 1,
      roll: 10,
      antennaAngle: 78,
      antennaLength: 15,
      tilt: 3,
      squash: 0.07,
      light: "blocked" as const,
    };
    const unlit = { ...blocked, light: "body" as const };
    const frame = avatarFrame("dome", blocked, 96);
    const [a, b, c, d, e, f] = frame.body;
    const { x, y, r } = frame.light;
    // Points halfway across the band between the light and the edge of its cutout.
    const band = (r + frame.lightCut) / 2;
    const ring = Array.from({ length: 24 }, (_, i) => {
      const px = x + band * Math.cos((i * Math.PI) / 12);
      const py = y + band * Math.sin((i * Math.PI) / 12);
      return toPx({ x: a * px + c * py + e, y: b * px + d * py + f });
    });
    const opaque = (canvas: Canvas) =>
      ring.filter((p) => (at(canvas, p.x, p.y)[3] ?? 0) === 255).length;
    // Without the cutout the body and the antenna fill much of the band; with it, none does.
    expect(opaque(draw(unlit))).toBeGreaterThan(8);
    expect(ring.every((p) => at(draw(blocked), p.x, p.y)[3] === 0)).toBe(true);
    const tip = toPx({ x: a * x + c * y + e, y: b * x + d * y + f });
    expect(near(at(draw(blocked), tip.x, tip.y), rgb(colors.blocked.light))).toBe(true);
  });

  it("hides the lens behind its lids when the eye is shut", () => {
    const shut = draw({ ...idle, shut: 1, curve: -5 });
    const open = draw(idle);
    const lens = rgb(avatarEye.lens);
    const pupil = rgb(avatarEye.pupil);
    const count = (canvas: Canvas, color: ArrayLike<number>) =>
      pixelsOf(canvas).filter((p) => (p.rgba[3] ?? 0) === 255 && near(p.rgba, color)).length;
    expect(count(open, pupil)).toBeGreaterThan(50);
    expect(count(shut, pupil)).toBe(0);
    // Only the closed eye's arc is left of the lens: far less than the open eye shows.
    expect(count(shut, lens)).toBeLessThan(count(open, lens) / 3);
  });
});

describe("an avatar's paint", () => {
  const size = 96;
  const pixel = (canvas: Canvas, p: { x: number; y: number }) => {
    const at = (Math.floor(p.y) * size + Math.floor(p.x)) * 4;
    return Array.from(canvas.pixels.subarray(at, at + 4));
  };
  const toPx = (p: { x: number; y: number }) => ({
    x: ((p.x - avatarViewBox.x) * size) / avatarViewBox.size,
    y: ((p.y - avatarViewBox.y) * size) / avatarViewBox.size,
  });
  const box = { x: 0, y: 0, size };

  it("as a silhouette, is white where it is drawn and cuts out its lens", () => {
    const face = { ...idle, pupil: 5 };
    const canvas = new Canvas(size, size);
    drawAvatar(canvas, { shape: "dome", color: "tomato" }, face, "light", box, {
      silhouette: true,
    });
    const drawn = pixelsOf(canvas).filter((p) => (p.rgba[3] ?? 0) > 0);
    expect(drawn.every((p) => near(p.rgba, [255, 255, 255]))).toBe(true);
    const frame = avatarFrame("dome", face, size);
    // The lens's edge, past the pupil and inside the eye, is clear; the pupil is white.
    const eye = { x: frame.eye[4], y: frame.eye[5] };
    expect(pixel(canvas, toPx({ x: eye.x - 10, y: eye.y }))[3]).toBe(0);
    expect(pixel(canvas, toPx(eye))[3]).toBe(255);
    // The body around the eye stays.
    expect(pixel(canvas, toPx({ x: eye.x, y: eye.y + 22 }))[3]).toBe(255);
  });

  it("fills a status light's cutout with the ground it is drawn on, and clears it without one", () => {
    const face = { ...idle, light: "blocked" as const };
    const frame = avatarFrame("dome", face, size);
    // In the band between the light and the cutout's edge.
    const band = toPx({
      x: frame.light.x,
      y: frame.light.y + (frame.light.r + frame.lightCut) / 2,
    });
    const ground = [20, 40, 60] as const;
    const onGround = new Canvas(size, size, ground);
    drawAvatar(onGround, { shape: "dome", color: "teal" }, face, "dark", box, { ground });
    const clear = new Canvas(size, size, ground);
    drawAvatar(clear, { shape: "dome", color: "teal" }, face, "dark", box);
    expect(pixel(onGround, band)).toEqual([...ground, 255]);
    expect(pixel(clear, band)[3]).toBe(0);
  });
});

describe("renderStillAvatar", () => {
  it("writes a PNG of the size asked, whose image data holds every pixel", () => {
    const size = 40;
    const png = renderStillAvatar({ shape: "hex", color: "tangerine" }, idle, "dark", size);
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(png.buffer, png.byteOffset);
    // The first chunk is the header: its width and height, then 8 bits per channel of RGBA.
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([size, size, 8, 6]);
    const idat = 8 + 25;
    const length = view.getUint32(idat);
    expect(new TextDecoder().decode(png.subarray(idat + 4, idat + 8))).toBe("IDAT");
    const rows = inflateSync(png.subarray(idat + 8, idat + 8 + length));
    // Each row is its filter byte, then four bytes a pixel.
    expect(rows.length).toBe(size * (1 + size * 4));
  });

  it.each([30.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a size of %s px",
    (size) => {
      expect(() =>
        renderStillAvatar({ shape: "dome", color: "teal" }, idle, "light", size),
      ).toThrow(RangeError);
    },
  );
});

describe("renderStillRoomAvatar", () => {
  it("cuts the front member out of the one behind it, as a room shows on a page", () => {
    const size = 100;
    const part = size * 0.68;
    const back = { shape: "loaf", color: "teal" } as const;
    const front = { shape: "loaf", color: "tangerine" } as const;
    const decode = (png: Uint8Array<ArrayBuffer>) => readPng(png).rgba;
    const room = decode(renderStillRoomAvatar([back, front], idle, "light", size));
    const backAlone = decode(renderStillRoomAvatar([back], idle, "light", size));
    const frontAlone = new Canvas(size, size);
    drawAvatar(frontAlone, front, idle, "light", { x: size - part, y: size - part, size: part });

    let cut = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mine = frontAlone.pixels[(y * size + x) * 4 + 3] ?? 0;
        if (mine > 0) {
          // The front member is drawn whole, over everything.
          expect(room(x, y)[3]).toBeGreaterThanOrEqual(mine);
        } else if (backAlone(x, y)[3] === 255 && room(x, y)[3] === 0) cut++;
      }
    }
    // A band of the back member, along the front one's outline, is left clear.
    expect(cut).toBeGreaterThan(40);
  });
});
