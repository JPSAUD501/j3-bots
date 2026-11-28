// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { writeTestProfile } from "@j3-bots/browser/testing";
import { oldEngineBrowser } from "@j3-bots/engine-t3";
import { writeOldEngineBrowser } from "@j3-bots/engine-t3/testing";
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
// the adapter lays out as the engine leaves it, with a profile a Chromium
// wrote for fake sites.

/** A Chromium to drive; CI and the checks set it, and without one the move's own test is skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

/** The engine's folder, with its browser profile, and the sign-ins over a new jar. */
const scene = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-" });
  const jarFolder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" });
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const jar = yield* openJarFile(path.join(jarFolder, "signins.sqlite"), key).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const signIns = yield* makeSignIns({ jar, digests: makeDigests(key) });
  return { engine, signIns };
});

const sites = (signIns: SignIns["Service"]) =>
  Effect.map(Stream.runHead(signIns.view), (view) =>
    Option.match(view, { onNone: () => [], onSome: ({ sites }) => sites.map(({ site }) => site) }),
  );

describe("moving the engine's browser's sign-ins", () => {
  it.live("waits for the browser that can read them, and removes nothing meanwhile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { engine, signIns } = yield* scene();
      const profile = yield* writeOldEngineBrowser(engine);
      yield* bringInOld(engine, path.join(engine, "moving")).pipe(
        Effect.provideService(SignIns, signIns),
      );
      assert.strictEqual(yield* signIns.toBringIn, "due");
      assert.isTrue(yield* fs.exists(profile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finds nothing to move in an engine that never browsed, and is done", () =>
    Effect.gen(function* () {
      const { signIns } = yield* scene();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-" });
      yield* bringInOld(empty, path.join(empty, "moving")).pipe(
        Effect.provideService(SignIns, signIns),
      );
      assert.strictEqual(yield* signIns.toBringIn, "done");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(executablePath === undefined)(
    "moves them into the shared sign-ins once, then removes the engine's browser",
    () =>
      Effect.gen(function* () {
        if (executablePath === undefined) return;
        const path = yield* Path.Path;
        const { engine, signIns } = yield* scene();
        const profile = yield* writeOldEngineBrowser(engine, executablePath);
        yield* writeTestProfile(profile, executablePath);

        yield* bringInOld(engine, path.join(engine, "moving")).pipe(
          Effect.provideService(SignIns, signIns),
        );
        assert.deepStrictEqual(yield* sites(signIns), ["example.test", "other.test"]);
        assert.strictEqual(yield* signIns.toBringIn, "done");
        const left = yield* oldEngineBrowser(engine);
        assert.deepStrictEqual(left.profiles, []);
        assert.isTrue(Option.isNone(left.executable));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
