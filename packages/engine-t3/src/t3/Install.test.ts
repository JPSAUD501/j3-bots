// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The release lists a SHA-256 of its archive, computed here as the install checks it; a folder swapped for a link mid-download takes node:fs, from inside the response body.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
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
 * asks for. Every request is recorded in `requests`: `SHA256SUMS`, or the
 * archive by the range it asks for, or `whole`. `afterArchive` runs once the
 * install has read the archive's last byte, before it has written it.
 */
const release = (requests: Array<string>, afterArchive: () => void) =>
  HttpClient.make((request) => {
    if (request.url === releaseUrl("SHA256SUMS")) {
      requests.push("SHA256SUMS");
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(`${DIGEST}  ${ARCHIVE_NAME}\n`)),
      );
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers["range"] ?? "");
    requests.push(range?.[0] ?? "whole");
    const from = Number(range?.[1] ?? 0);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(ARCHIVE.slice(from)),
      pull: (controller) => {
        afterArchive();
        controller.close();
      },
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(body, { status: from > 0 ? 206 : 200 })),
    );
  });

/** Where an install keeps its download and unpacks it. */
interface Workspace {
  readonly runtime: string;
  readonly partial: string;
  readonly staging: string;
}

interface Setup {
  /** Prepares the workspace before the install starts. */
  readonly prepare?: (workspace: Workspace) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Runs once the install has read the whole archive, before it has written it. */
  readonly afterArchive?: (workspace: Workspace) => void;
  /**
   * Whether only what is inside the home, links resolved, counts as private.
   * Otherwise every location does, and what refuses a link is the write itself.
   */
  readonly homeOnly?: boolean;
}

/** Whether `location`, through its nearest parent that exists, links resolved, is inside `home`. */
const insideHome = Effect.fn("insideHome")(function* (home: string, location: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let existing = location;
  while (!(yield* fs.exists(existing))) existing = path.dirname(existing);
  const real = yield* fs.realPath(existing);
  const realHome = yield* fs.realPath(home);
  return real === realHome || real.startsWith(`${realHome}/`);
});

/** Installs into a fresh home, set up as `setup` says. */
const install = (requests: Array<string>, setup: Setup) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const runtime = path.join(home, "j3", "runtime");
    yield* fs.makeDirectory(runtime, { recursive: true });
    const workspace: Workspace = {
      runtime,
      partial: path.join(runtime, `${pin.version}.partial`),
      staging: path.join(runtime, `${pin.version}.staging`),
    };
    yield* setup.prepare?.(workspace) ?? Effect.void;
    const files = yield* makePrivateFiles((location) =>
      setup.homeOnly === true
        ? insideHome(home, location).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.orElseSucceed(() => false),
          )
        : Effect.succeed(true),
    );
    const exit = yield* ensureInstalled({ home, platform: "linux", arch: "x64", files }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        release(requests, () => setup.afterArchive?.(workspace)),
      ),
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

      const { partial, reason } = yield* install(requests, {
        prepare: ({ partial }) => fs.symlink(outside, partial),
      });

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

      const { partial, reason } = yield* install(requests, {
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(requests, ["SHA256SUMS", "bytes=10-"]);
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

      const { staging, reason } = yield* install([], {
        prepare: ({ staging }) => fs.symlink(outside, staging),
      });

      // The download matched; only unpacking it failed, in a folder of its own.
      assert.strictEqual(reason, "extract");
      assert.deepStrictEqual(yield* fs.readDirectory(outside), ["owner-file"]);
      assert.strictEqual((yield* fs.lstat(staging)).type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("removes what an install cut off after publishing left, and runs the engine", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const installed = ({ runtime, partial, staging }: Workspace) =>
        Effect.all([
          fs.makeDirectory(path.join(runtime, pin.version)),
          fs.writeFileString(path.join(runtime, pin.version, ".installed"), `${DIGEST}\n`),
          fs.writeFile(partial, ARCHIVE),
          fs.makeDirectory(path.join(staging, "t3"), { recursive: true }),
        ]);
      const requests: Array<string> = [];

      const left = yield* install(requests, { prepare: installed });
      assert.isUndefined(left.reason);
      assert.deepStrictEqual(requests, []);
      assert.isFalse(yield* fs.exists(left.partial));
      assert.isFalse(yield* fs.exists(left.staging));

      // A leftover that cannot be removed is no reason to stop.
      const outside = yield* fs.makeTempDirectoryScoped();
      const kept = yield* install(requests, {
        homeOnly: true,
        prepare: (workspace) =>
          Effect.gen(function* () {
            yield* fs.remove(workspace.runtime, { recursive: true });
            yield* fs.symlink(outside, workspace.runtime);
            yield* installed(workspace);
          }),
      });
      assert.isUndefined(kept.reason);
      assert.isTrue(yield* fs.exists(path.join(outside, `${pin.version}.partial`)));
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect(
    "neither reads nor removes through a runtime folder swapped for a link mid-download",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* fs.makeTempDirectoryScoped();
        const ownerFile = path.join(outside, `${pin.version}.partial`);
        yield* fs.writeFileString(ownerFile, "the owner's file");

        const { reason } = yield* install([], {
          homeOnly: true,
          afterArchive: ({ runtime }) => {
            NodeFs.renameSync(runtime, `${runtime}.moved`);
            NodeFs.symlinkSync(outside, runtime);
          },
        });

        assert.strictEqual(reason, "storage");
        assert.strictEqual(yield* fs.readFileString(ownerFile), "the owner's file");
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
