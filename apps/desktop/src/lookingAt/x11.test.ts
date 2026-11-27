// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The X server the reader meets is a plain node:net listener that speaks the replies it asks for.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { QuickAccessPicture } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { bgraOf, x11Reader } from "./x11.ts";

const ROOT = 0x100;
const WINDOW = 0x2a00007;
const VISUAL = 0x21;
const ATOMS: Readonly<Record<string, number>> = {
  _NET_ACTIVE_WINDOW: 300,
  _NET_WM_NAME: 301,
  UTF8_STRING: 302,
  _NET_WM_CM_S0: 303,
};
const WINDOW_TYPE = 33;
const CARDINAL = 6;
const STRING = 31;
const WM_CLASS = 67;

const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

/** The setup of a server with one screen, whose visual holds 0x00RRGGBB in a 32-bit pixel. */
const setup = () => {
  const body = Buffer.alloc(32 + 8 + 40 + 8 + 24);
  body.writeUInt16LE(0, 16); // no vendor
  body.writeUInt8(1, 20); // screens
  body.writeUInt8(1, 21); // formats
  body.writeUInt8(0, 22); // images least significant byte first
  body.writeUInt8(24, 32); // format: depth 24…
  body.writeUInt8(32, 33); // …at 32 bits per pixel
  body.writeUInt32LE(ROOT, 40);
  body.writeUInt8(1, 79); // depths
  body.writeUInt8(24, 80);
  body.writeUInt16LE(1, 82); // visuals
  body.writeUInt32LE(VISUAL, 88);
  body.writeUInt32LE(0xff0000, 96);
  body.writeUInt32LE(0x00ff00, 100);
  body.writeUInt32LE(0x0000ff, 104);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(body.length / 4, 6);
  return Buffer.concat([header, body]);
};

/** A reply: 32 bytes, then `extra` padded to four. */
const reply = (write: (head: Buffer) => void, extra: Buffer = Buffer.alloc(0)) => {
  const padded = Buffer.concat([extra, Buffer.alloc((4 - (extra.length % 4)) % 4)]);
  const head = Buffer.alloc(32);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(padded.length / 4, 4);
  write(head);
  return Buffer.concat([head, padded]);
};

interface Held {
  readonly type: number;
  readonly value: Buffer;
  readonly format: 8 | 32;
}

interface Desktop {
  /** Properties by window, then by atom: their type and value, of 8-bit or 32-bit units. */
  readonly properties: ReadonlyMap<number, ReadonlyMap<number, Held>>;
  readonly composited: boolean;
  /** The window's pixels, 0x00RRGGBB each, least significant byte first. */
  readonly pixels: Buffer;
  readonly size: { readonly width: number; readonly height: number };
}

/** An X server, as far as the reader goes, with `desktop` on its one screen. Answers where it listens. */
const xServer = (desktop: Desktop) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-x11-" });
    const at =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${path.basename(folder)}`
        : path.join(folder, "X0");
    const answer = (request: Buffer): Buffer => {
      switch (request.readUInt8(0)) {
        case 16: {
          const name = request.subarray(8, 8 + request.readUInt16LE(4)).toString("latin1");
          return reply((head) => head.writeUInt32LE(ATOMS[name] ?? 0, 8));
        }
        case 20: {
          const held = desktop.properties
            .get(request.readUInt32LE(4))
            ?.get(request.readUInt32LE(8));
          if (held === undefined) return reply(() => {});
          return reply(
            (head) => {
              head.writeUInt8(held.format, 1);
              head.writeUInt32LE(held.type, 8);
              head.writeUInt32LE(held.value.length / (held.format / 8), 16);
            },
            // AnyPropertyType (0), or the type it holds: its value; another type: none.
            [0, held.type].includes(request.readUInt32LE(12)) ? held.value : Buffer.alloc(0),
          );
        }
        case 23:
          return reply((head) => head.writeUInt32LE(desktop.composited ? 0x400001 : 0, 8));
        case 3:
          return reply((head) => {
            head.writeUInt32LE(VISUAL, 8);
            head.writeUInt8(2, 26);
          });
        case 14:
          return reply((head) => {
            head.writeUInt8(24, 1);
            head.writeUInt16LE(desktop.size.width, 16);
            head.writeUInt16LE(desktop.size.height, 18);
          });
        case 73:
          return reply((head) => head.writeUInt8(24, 1), desktop.pixels);
        default:
          // An error, which no request the reader makes should meet.
          return Buffer.alloc(32);
      }
    };
    yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server>((resume) => {
        const server = NodeNet.createServer((socket) => {
          let received = Buffer.alloc(0);
          let greeted = false;
          socket.on("error", () => socket.destroy());
          socket.on("data", (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            if (!greeted) {
              if (received.length < 12) return;
              received = received.subarray(12);
              greeted = true;
              socket.write(setup());
            }
            while (received.length >= 4) {
              const length = received.readUInt16LE(2) * 4;
              if (received.length < length) return;
              socket.write(answer(received.subarray(0, length)));
              received = received.subarray(length);
            }
          });
        });
        server.listen(at, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
    return at;
  });

const latin1 = (text: string) => Buffer.from(text, "latin1");

/**
 * A desktop whose active window is a browser's, titled `title`, which its
 * window manager names as a `WINDOW`, or, as some do, a `CARDINAL`.
 */
const browser = (title: string, composited = true, activeType = WINDOW_TYPE): Desktop => ({
  properties: new Map<number, ReadonlyMap<number, Held>>([
    [
      ROOT,
      new Map([
        [ATOMS["_NET_ACTIVE_WINDOW"] ?? 0, { type: activeType, value: uint32(WINDOW), format: 32 }],
      ]),
    ],
    [
      WINDOW,
      new Map([
        [WM_CLASS, { type: STRING, value: latin1("navigator\0Example-browser\0"), format: 8 }],
        [
          ATOMS["_NET_WM_NAME"] ?? 0,
          { type: ATOMS["UTF8_STRING"] ?? 0, value: Buffer.from(title), format: 8 },
        ],
      ]),
    ],
  ]),
  composited,
  pixels: Buffer.from([0x30, 0x20, 0x10, 0x00, 0x60, 0x50, 0x40, 0x00]),
  size: { width: 2, height: 1 },
});

const pictures: Array<{ bgra: Uint8Array; width: number; height: number }> = [];
const reader = (path: string, named: string | null) =>
  x11Reader({
    server: { path, screen: 0, cookie: null },
    appName: () => Effect.succeed(named),
    pictureFrom: (bgra, width, height): QuickAccessPicture => {
      pictures.push({ bgra, width, height });
      return { _tag: "failed" };
    },
  });

describe("reading the window in front on X11", () => {
  it.effect("reads its app, by the name its desktop entry gives, and its title", () =>
    Effect.gen(function* () {
      const path = yield* xServer(browser("Pull request #12 — Example"));
      const front = yield* reader(path, "Example Browser").front({ withTitle: true });
      assert.deepStrictEqual(front?.lookingAt, {
        app: "Example Browser",
        title: "Pull request #12 — Example",
      });
      // A window manager that names the active window as a CARDINAL is read the same.
      const cardinal = yield* xServer(browser("Pull request #12 — Example", true, CARDINAL));
      const named = yield* reader(cardinal, "Example Browser").front({ withTitle: true });
      assert.strictEqual(named?.lookingAt.title, "Pull request #12 — Example");
      // Titles off: the app alone, its class's name when no entry names it.
      const untitled = yield* reader(path, null).front({ withTitle: false });
      assert.deepStrictEqual(untitled?.lookingAt, { app: "Example-browser" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads nothing when no window is active, or the server is not there", () =>
    Effect.gen(function* () {
      const path = yield* xServer({ ...browser("Anything"), properties: new Map() });
      assert.isNull(yield* reader(path, "Example Browser").front({ withTitle: true }));
      assert.isNull(yield* reader(`${path}-gone`, "Example Browser").front({ withTitle: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes the window's own pixels only where a compositing manager keeps them", () =>
    Effect.gen(function* () {
      const bare = yield* reader(yield* xServer(browser("Notes", false)), null).front({
        withTitle: true,
      });
      assert.strictEqual(bare?.picture, "none");

      const front = yield* reader(yield* xServer(browser("Notes")), null).front({
        withTitle: true,
      });
      assert.strictEqual(front?.picture, "available");
      yield* front?.takePicture ?? Effect.void;
      assert.deepStrictEqual(pictures.at(-1), {
        bgra: Uint8Array.from([0x30, 0x20, 0x10, 0xff, 0x60, 0x50, 0x40, 0xff]),
        width: 2,
        height: 1,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads a pixel's bytes in the order the server keeps them", () => {
    const pixel = Uint8Array.from([0x00, 0x10, 0x20, 0x30]);
    assert.deepStrictEqual(bgraOf(pixel, 1, 1, "msb"), Uint8Array.from([0x30, 0x20, 0x10, 0xff]));
    assert.isNull(bgraOf(pixel, 2, 1, "lsb"));
  });
});
