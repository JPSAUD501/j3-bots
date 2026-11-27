// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { writeTestProfile } from "@j3-bots/browser/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { bringInOld } from "./bringIn.ts";
import { makeDigests } from "./canonical.ts";
import { openJarFile } from "./JarFile.ts";
import { makeSignIns, SignIns } from "./SignIns.ts";

// The one move of the engine's browser's sign-ins, against an engine folder
// laid out as the engine leaves it, with a profile a Chromium wrote for fake
// sites.

/** A Chromium to drive; CI and the checks set it, and without one the move's own test is skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

const BUILD = process.arch === "arm64" ? "linux-arm64" : "linux64";

/** The engine's folder, with its browser profile, and the sign-ins over a new jar. */
const scene = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-" });
  const profile = path.join(engine, "userdata", "server-browser", "profiles", "default");
  yield* fs.makeDirectory(profile, { recursive: true });
  const browser = path.join(engine, "tools", "chrome-headless-shell", BUILD, "158.0.8127.88");
  const jarFolder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" });
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const jar = yield* openJarFile(path.join(jarFolder, "signins.sqlite"), key).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const signIns = yield* makeSignIns({ jar, digests: makeDigests(key) });
  return { engine, profile, browser, signIns };
});

const sites = (signIns: SignIns["Service"]) =>
  Effect.map(Stream.runHead(signIns.view), (view) =>
    Option.match(view, { onNone: () => [], onSome: ({ sites }) => sites.map(({ site }) => site) }),
  );

describe("moving the engine's browser's sign-ins", () => {
  it.live("waits for the browser that can read them, and removes nothing meanwhile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { engine, profile, signIns } = yield* scene();
      yield* bringInOld(engine).pipe(Effect.provideService(SignIns, signIns));
      assert.strictEqual(yield* signIns.toBringIn, "due");
      assert.isTrue(yield* fs.exists(profile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finds nothing to move in an engine that never browsed, and is done", () =>
    Effect.gen(function* () {
      const { signIns } = yield* scene();
      const fs = yield* FileSystem.FileSystem;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-" });
      yield* bringInOld(empty).pipe(Effect.provideService(SignIns, signIns));
      assert.strictEqual(yield* signIns.toBringIn, "done");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(executablePath === undefined)(
    "moves them into the shared sign-ins once, then removes the engine's browser",
    () =>
      Effect.gen(function* () {
        if (executablePath === undefined) return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { engine, profile, browser, signIns } = yield* scene();
        yield* writeTestProfile(profile, executablePath);
        yield* fs.makeDirectory(browser, { recursive: true });
        yield* fs.symlink(executablePath, path.join(browser, "chrome-headless-shell"));

        yield* bringInOld(engine).pipe(Effect.provideService(SignIns, signIns));
        assert.deepStrictEqual(yield* sites(signIns), ["example.test", "other.test"]);
        assert.strictEqual(yield* signIns.toBringIn, "done");
        assert.isFalse(yield* fs.exists(path.join(engine, "userdata", "server-browser")));
        assert.isFalse(yield* fs.exists(path.join(engine, "tools", "chrome-headless-shell")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
