// SPDX-License-Identifier: AGPL-3.0-or-later
import { PairingCode, PairingLink, ServerOrigin } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
// jsQR is CommonJS whose types declare its function as `default`.
import jsQR from "jsqr";
import { terminalQr } from "./qr.ts";

/** The colors a printed line switches to and back, which draw nothing. */
const ESCAPES = /\x1b\[[0-9;]*m/g;

/** Pixels per module, as a camera would see the terminal's cells. */
const SCALE = 4;

/**
 * What a terminal shows for `printed`, as an image: each character is one
 * module wide and two tall, its upper and lower halves dark where the half
 * block covers them. Escape sequences draw nothing.
 */
const picture = (printed: string) => {
  const rows = printed
    .replaceAll(ESCAPES, "")
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
  for (const server of [
    "http://192.0.2.10:3737",
    "http://100.64.0.7:3737",
    "https://j3.example.test",
  ]) {
    const carried = { ...target, server: Schema.decodeSync(ServerOrigin)(server) };
    const qr = terminalQr(Schema.encodeSync(PairingLink)(carried), [], roomy);
    assert.strictEqual(qr._tag, "shown", server);
    if (qr._tag !== "shown") return;
    const { pixels, width, height } = picture(qr.lines);
    const read = jsQR.default(pixels, width, height, { inversionAttempts: "dontInvert" });
    assert.isNotNull(read, server);
    assert.strictEqual(read!.data, `${server}/pair#7KQ2M9XH4D`);
    assert.deepStrictEqual(Schema.decodeSync(PairingLink)(read!.data), carried);
  }
});

it("prints its caption above the code, and the code last", () => {
  const caption = ["", "It opens J3 Bots at http://192.0.2.10:3737."];
  const qr = terminalQr(link, caption, roomy);
  const bare = terminalQr(link, [], roomy);
  assert.strictEqual(qr._tag, "shown");
  assert.strictEqual(bare._tag, "shown");
  if (qr._tag !== "shown" || bare._tag !== "shown") return;
  assert.strictEqual(qr.lines, [...caption, bare.lines].join("\n"));
});

it("draws nothing where standard output is not a terminal", () => {
  assert.deepStrictEqual(terminalQr(link, [], { ...roomy, isTerminal: false }), {
    _tag: "not-a-terminal",
  });
});

it("draws nothing unless the caption, the code with its quiet zone and the prompt fit, and says what does", () => {
  const bare = terminalQr(link, [], roomy);
  assert.strictEqual(bare._tag, "shown");
  if (bare._tag !== "shown") return;
  const codeLines = bare.lines.split("\n");
  const side = [...codeLines[0]!.replaceAll(ESCAPES, "")].length;
  // A blank line, and one a terminal exactly as wide as the code wraps onto two rows.
  const caption = ["", "x".repeat(side + 1)];
  const needed = { columns: side, rows: 1 + 2 + codeLines.length + 1 };
  const on = (columns: number, rows: number) =>
    terminalQr(link, caption, { isTerminal: true, columns, rows });
  const tooSmall = { _tag: "too-small" as const, ...needed };
  assert.deepStrictEqual(on(side - 1, 60), tooSmall);
  assert.deepStrictEqual(on(side, needed.rows - 1), tooSmall);
  assert.strictEqual(on(side, needed.rows)._tag, "shown");
  // Wider, the long line takes one row, so one row fewer is enough.
  assert.strictEqual(on(side + 1, needed.rows - 1)._tag, "shown");
});
