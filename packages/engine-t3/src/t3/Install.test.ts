// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The release lists a SHA-256 of its archive, computed here as the install checks it.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ensureInstalled } from "./Install.ts";
import { archiveName, pin, releaseUrl } from "./Pin.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";

/** The release's archive. Not a real one: the install stops at unpacking it. */
const ARCHIVE = new TextEncoder().encode("the pinned engine release, byte for byte");
const ARCHIVE_NAME = archiveName("linux-x64");
const DIGEST = NodeCrypto.createHash("sha256").update(ARCHIVE).digest("hex");

/**
 * The release server: its checksums, and the archive, from the byte a range
 * asks for. Every range asked is recorded in `ranges`.
 */
const release = (ranges: Array<string>) =>
  HttpClient.make((request) => {
    if (request.url === releaseUrl("SHA256SUMS")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(`${DIGEST}  ${ARCHIVE_NAME}\n`)),
      );
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers["range"] ?? "");
    if (range?.[1] !== undefined) ranges.push(range[0]);
    const from = Number(range?.[1] ?? 0);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(ARCHIVE.slice(from), { status: from > 0 ? 206 : 200 }),
      ),
    );
  });

/** Installs into a fresh home, with the download in `partial` prepared by `prepare`. */
const install = (
  ranges: Array<string>,
  prepare: (partial: string) => Effect.Effect<void, PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const runtime = path.join(home, "j3", "runtime");
    yield* fs.makeDirectory(runtime, { recursive: true });
    const partial = path.join(runtime, `${pin.version}.partial`);
    yield* prepare(partial);
    // Every location counts as private: what refuses a link here is the write itself.
    const files = yield* makePrivateFiles(() => Effect.succeed(true));
    const exit = yield* ensureInstalled({ home, platform: "linux", arch: "x64", files }).pipe(
      Effect.provideService(HttpClient.HttpClient, release(ranges)),
      Effect.exit,
    );
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return { home, partial, reason: Option.getOrUndefined(error)?.reason };
  });

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto);

describe("ensureInstalled", () => {
  it.effect("never writes a download through a link planted where it resumes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = path.join(yield* fs.makeTempDirectoryScoped(), "owner-file");
      yield* fs.writeFileString(outside, "the owner's file");

      const { partial, reason } = yield* install([], (partial) => fs.symlink(outside, partial));

      assert.strictEqual(reason, "storage");
      assert.strictEqual(yield* fs.readFileString(outside), "the owner's file");
      assert.strictEqual((yield* fs.lstat(partial)).type, "SymbolicLink");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("resumes an interrupted download from where it stopped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ranges: Array<string> = [];

      const { partial, reason } = yield* install(ranges, (partial) =>
        fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      );

      assert.deepStrictEqual(ranges, ["bytes=10-"]);
      // The resumed file matched the release's digest; only unpacking it failed.
      assert.strictEqual(reason, "extract");
      assert.deepStrictEqual(yield* fs.readFile(partial), ARCHIVE);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
