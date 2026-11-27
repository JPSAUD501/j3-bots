// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The X server the check meets is a plain node:net listener that speaks its three replies.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { compositingManagerRuns } from "./compositing.ts";
import { cookieFor, parseDisplay } from "./x11.ts";

const COOKIE = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const ATOM = 0x1a2;

/** A reply of the X protocol: 32 bytes, its value where an atom or a window stands. */
const reply = (value: number) => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt8(1, 0);
  bytes.writeUInt32LE(value, 8);
  return bytes;
};

/**
 * An X server, as far as the check goes: it takes a connection that brings
 * `COOKIE`, knows the screen's selection as `atom` (0: nobody ever made it),
 * and says `owner` owns it. Answers the path it listens at; closed with the scope.
 */
const xServer = (screen: { readonly atom: number; readonly owner: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-x11-" });
    // Windows has no socket files: a named pipe stands in for one.
    const at =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${path.basename(folder)}`
        : path.join(folder, "X0");
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
              const name = received.readUInt16LE(6);
              const data = received.readUInt16LE(8);
              const dataAt = 12 + Math.ceil(name / 4) * 4;
              const length = dataAt + Math.ceil(data / 4) * 4;
              if (received.length < length) return;
              const brought = received.subarray(dataAt, dataAt + data);
              const named = received.subarray(12, 12 + name).toString("latin1");
              received = received.subarray(length);
              greeted = true;
              const known = named === "MIT-MAGIC-COOKIE-1" && brought.equals(Buffer.from(COOKIE));
              // Refused: one byte of status, then a reason this check never reads.
              const header = Buffer.alloc(8);
              header.writeUInt8(known ? 1 : 0, 0);
              header.writeUInt16LE(11, 2);
              header.writeUInt16LE(1, 6);
              socket.write(Buffer.concat([header, Buffer.alloc(4)]));
              if (!known) socket.end();
            }
            while (received.length >= 8) {
              const opcode = received.readUInt8(0);
              const length = received.readUInt16LE(2) * 4;
              if (received.length < length) return;
              const request = received.subarray(0, length);
              received = received.subarray(length);
              if (opcode === 16) {
                const asked = request.subarray(8, 8 + request.readUInt16LE(4)).toString("latin1");
                socket.write(reply(asked === "_NET_WM_CM_S0" ? screen.atom : 0));
              } else if (opcode === 23) {
                socket.write(reply(request.readUInt32LE(4) === screen.atom ? screen.owner : 0));
              }
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

const asked = (path: string, cookie: Uint8Array | null = COOKIE) =>
  compositingManagerRuns({ path, screen: 0, cookie, timeoutMs: 2000 });

describe("whether a window can be see-through on X11", () => {
  it.effect("says a compositing manager runs when a window owns the screen's selection", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* asked(yield* xServer({ atom: ATOM, owner: 0x400001 })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says none runs when nothing owns the selection, or nobody ever named it", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* asked(yield* xServer({ atom: ATOM, owner: 0 })));
      assert.isFalse(yield* asked(yield* xServer({ atom: 0, owner: 0 })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot tell when the server refuses it, or is not there", () =>
    Effect.gen(function* () {
      const path = yield* xServer({ atom: ATOM, owner: 0x400001 });
      assert.isNull(yield* asked(path, null));
      assert.isNull(yield* asked(`${path}-gone`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("asks only a display on this computer", () => {
    assert.deepStrictEqual(parseDisplay(":0"), { number: "0", screen: 0 });
    assert.deepStrictEqual(parseDisplay(":12.1"), { number: "12", screen: 1 });
    assert.deepStrictEqual(parseDisplay("unix:1"), { number: "1", screen: 0 });
    assert.isNull(parseDisplay("elsewhere:0"));
    assert.isNull(parseDisplay(undefined));
    assert.isNull(parseDisplay(""));
  });

  it("finds this display's cookie in an authority file, this host's before another's", () => {
    const counted = (text: string | Uint8Array) => {
      const bytes = typeof text === "string" ? Buffer.from(text, "latin1") : Buffer.from(text);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const entry = (
      family: number,
      host: string,
      display: string,
      name: string,
      data: Uint8Array,
    ) => {
      const head = Buffer.alloc(2);
      head.writeUInt16BE(family);
      return Buffer.concat([head, counted(host), counted(display), counted(name), counted(data)]);
    };
    const other = Uint8Array.from({ length: 16 }, () => 9);
    const file = Buffer.concat([
      entry(256, "old-name", "0", "MIT-MAGIC-COOKIE-1", other),
      entry(256, "this-host", "1", "MIT-MAGIC-COOKIE-1", other),
      entry(256, "this-host", "0", "XDM-AUTHORIZATION-1", other),
      entry(256, "this-host", "0", "MIT-MAGIC-COOKIE-1", COOKIE),
    ]);
    assert.deepStrictEqual(cookieFor(file, "0", "this-host"), Buffer.from(COOKIE));
    // A host that changed its name still finds the display's cookie.
    assert.deepStrictEqual(cookieFor(file, "0", "new-name"), Buffer.from(other));
    assert.isNull(cookieFor(file, "7", "this-host"));
    // A file cut short holds what came whole before the cut.
    assert.isNull(cookieFor(file.subarray(0, 20), "0", "this-host"));
    assert.deepStrictEqual(
      cookieFor(entry(65535, "", "", "MIT-MAGIC-COOKIE-1", COOKIE), "3", "this-host"),
      Buffer.from(COOKIE),
    );
  });
});
