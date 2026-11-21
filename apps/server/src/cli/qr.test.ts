// SPDX-License-Identifier: AGPL-3.0-or-later
import { PairingCode, PairingLink, ServerOrigin } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
// jsQR is CommonJS whose types declare its function as `default`.
import jsQR from "jsqr";
import { terminalQr } from "./qr.ts";

/** Pixels per module, as a camera would see the terminal's cells. */
const SCALE = 4;

/**
 * What a terminal shows for `printed`, as an image: each character is one
 * module wide and two tall, its upper and lower halves dark where the half
 * block covers them. Escape sequences draw nothing.
 */
const picture = (printed: string) => {
  const rows = printed
    .replaceAll(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .flatMap((line) => {
      const cells = [...line];
      return [
        cells.map((cell) => cell === "█" || cell === "▀"),
        cells.map((cell) => cell === "█" || cell === "▄"),
      ];
    });
  const width = rows[0]!.length * SCALE;
  const height = rows.length * SCALE;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shade = rows[Math.floor(y / SCALE)]![Math.floor(x / SCALE)] ? 0 : 255;
      pixels.set([shade, shade, shade, 255], (y * width + x) * 4);
    }
  }
  return { pixels, width, height };
};

const target = {
  server: Schema.decodeSync(ServerOrigin)("http://192.0.2.10:3737"),
  code: PairingCode.make("7KQ2M9XH4D"),
};
const link = Schema.encodeSync(PairingLink)(target);
const roomy = { isTerminal: true, columns: 120, rows: 60 };

it("prints a pairing link a camera reads back as the server and the code", () => {
  const qr = terminalQr(link, roomy);
  assert.strictEqual(qr._tag, "shown");
  if (qr._tag !== "shown") return;
  const { pixels, width, height } = picture(qr.lines);
  const read = jsQR.default(pixels, width, height, { inversionAttempts: "dontInvert" });
  assert.isNotNull(read);
  assert.deepStrictEqual(Schema.decodeSync(PairingLink)(read!.data), target);
});

it("draws nothing where standard output is not a terminal", () => {
  assert.deepStrictEqual(terminalQr(link, { ...roomy, isTerminal: false }), {
    _tag: "not-a-terminal",
  });
});

it("draws nothing on a terminal too small for the code and its quiet zone, and says what it needs", () => {
  const qr = terminalQr(link, roomy);
  assert.strictEqual(qr._tag, "shown");
  if (qr._tag !== "shown") return;
  const lines = qr.lines.split("\n");
  const needed = {
    columns: [...lines[0]!.replaceAll(/\x1b\[[0-9;]*m/g, "")].length,
    rows: lines.length,
  };
  assert.deepStrictEqual(terminalQr(link, { ...roomy, columns: needed.columns - 1 }), {
    _tag: "too-small",
    ...needed,
  });
  assert.deepStrictEqual(terminalQr(link, { ...roomy, rows: needed.rows - 1 }), {
    _tag: "too-small",
    ...needed,
  });
  assert.strictEqual(terminalQr(link, { ...roomy, ...needed })._tag, "shown");
});
