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
 * asks for. Every request for the archive is recorded in `requests`, by the
 * range it asks for, or `whole`.
 */
const release = (requests: Array<string>) =>
  HttpClient.make((request) => {
    if (request.url === releaseUrl("SHA256SUMS")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(`${DIGEST}  ${ARCHIVE_NAME}\n`)),
      );
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers["range"] ?? "");
    requests.push(range?.[0] ?? "whole");
    const from = Number(range?.[1] ?? 0);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(ARCHIVE.slice(from), { status: from > 0 ? 206 : 200 }),
      ),
    );
  });

/** Where an install keeps its download and unpacks it. */
interface Workspace {
  readonly partial: string;
  readonly staging: string;
}

/** Installs into a fresh home, with its workspace prepared by `prepare`. */
const install = (
  requests: Array<string>,
  prepare: (workspace: Workspace) => Effect.Effect<void, PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const runtime = path.join(home, "j3", "runtime");
    yield* fs.makeDirectory(runtime, { recursive: true });
    const workspace: Workspace = {
      partial: path.join(runtime, `${pin.version}.partial`),
      staging: path.join(runtime, `${pin.version}.staging`),
    };
    yield* prepare(workspace);
    // Every location counts as private: what refuses a link here is the write itself.
    const files = yield* makePrivateFiles(() => Effect.succeed(true));
    const exit = yield* ensureInstalled({ home, platform: "linux", arch: "x64", files }).pipe(
      Effect.provideService(HttpClient.HttpClient, release(requests)),
      Effect.exit,
    );
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return { ...workspace, reason: Option.getOrUndefined(error)?.reason };
  });

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto);

describe("ensureInstalled", () => {
  it.effect("refuses a link planted where it resumes, before downloading anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = path.join(yield* fs.makeTempDirectoryScoped(), "owner-file");
      yield* fs.writeFileString(outside, "the owner's file");
      const requests: Array<string> = [];

      const { partial, reason } = yield* install(requests, ({ partial }) =>
        fs.symlink(outside, partial),
      );

      assert.strictEqual(reason, "storage");
      assert.deepStrictEqual(requests, []);
      assert.strictEqual(yield* fs.readFileString(outside), "the owner's file");
      assert.strictEqual((yield* fs.lstat(partial)).type, "SymbolicLink");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("resumes an interrupted download from where it stopped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requests: Array<string> = [];

      const { partial, reason } = yield* install(requests, ({ partial }) =>
        fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      );

      assert.deepStrictEqual(requests, ["bytes=10-"]);
      // The resumed file matched the release's digest; only unpacking it failed.
      assert.strictEqual(reason, "extract");
      assert.deepStrictEqual(yield* fs.readFile(partial), ARCHIVE);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("never unpacks into or clears through a link planted where it unpacks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(outside, "owner-file"), "the owner's file");

      const { staging, reason } = yield* install([], ({ staging }) => fs.symlink(outside, staging));

      // The download matched; only unpacking it failed, in a folder of its own.
      assert.strictEqual(reason, "extract");
      assert.deepStrictEqual(yield* fs.readDirectory(outside), ["owner-file"]);
      assert.strictEqual((yield* fs.lstat(staging)).type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
