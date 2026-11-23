// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The pin holds a SHA-256 of the archive, computed here as the install checks it; a folder swapped for a link mid-download takes node:fs, from inside the response body; a real archive to unpack is made with tar.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EngineInstallProgress } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as PlatformError from "effect/PlatformError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { EngineInstallFailed, ensureInstalled, installTracked } from "./Install.ts";
import { pin } from "./Pin.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";
import type { ProcessState } from "./Supervisor.ts";

/** The release's archive. Not a real one: the install stops at unpacking it. */
const ARCHIVE = new TextEncoder().encode("the pinned engine release, byte for byte");
const DIGEST = NodeCrypto.createHash("sha256").update(ARCHIVE).digest("hex");

/** How the release server sends the archive. */
interface Sending {
  /** Whether it says the archive's size: `Content-Length`, and a range's `Content-Range`. */
  readonly sized: boolean;
  /** Bytes per chunk of the body, or the whole rest in one. */
  readonly chunk?: number;
}

/**
 * The release server: the archive, from the byte a range asks for. Every
 * request is recorded in `requests`: the range it asks for, or `whole`.
 * `afterArchive` runs once the install has read the archive's last byte,
 * before it has written it.
 */
const release = (
  requests: Array<string>,
  afterArchive: () => void,
  sending: Sending = { sized: true },
) =>
  HttpClient.make((request) => {
    const range = /^bytes=(\d+)-$/.exec(request.headers["range"] ?? "");
    requests.push(range?.[0] ?? "whole");
    const from = Number(range?.[1] ?? 0);
    const rest = ARCHIVE.slice(from);
    const size = sending.chunk ?? rest.length;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (let at = 0; at < rest.length; at += size) {
          controller.enqueue(rest.slice(at, at + size));
        }
      },
      pull: (controller) => {
        afterArchive();
        controller.close();
      },
    });
    const headers: Record<string, string> = sending.sized
      ? {
          "content-length": String(rest.length),
          ...(from > 0
            ? { "content-range": `bytes ${from}-${ARCHIVE.length - 1}/${ARCHIVE.length}` }
            : {}),
        }
      : {};
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status: from > 0 ? 206 : 200, headers }),
      ),
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
  /** The digest pinned for the archive. Otherwise the one the release serves. */
  readonly pinned?: string;
  /** How the release server sends it. Otherwise sized, in one chunk. */
  readonly sending?: Sending;
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
    const progress: Array<EngineInstallProgress> = [];
    const exit = yield* ensureInstalled({
      home,
      platform: "linux",
      arch: "x64",
      sha256: { "linux-x64": setup.pinned ?? DIGEST },
      files,
      onProgress: (reported) => Effect.sync(() => progress.push(reported)),
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        release(requests, () => setup.afterArchive?.(workspace), setup.sending),
      ),
      Effect.exit,
    );
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return { ...workspace, progress, reason: Option.getOrUndefined(error)?.reason };
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

      const { partial, progress, reason } = yield* install(requests, {
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(requests, ["bytes=10-"]);
      // It counts what it had, of the size the range says.
      assert.deepStrictEqual(progress, [
        { receivedBytes: 10, totalBytes: ARCHIVE.length },
        { receivedBytes: ARCHIVE.length, totalBytes: ARCHIVE.length },
      ]);
      // The resumed file matched the pinned digest; only unpacking it failed.
      assert.strictEqual(reason, "extract");
      assert.deepStrictEqual(yield* fs.readFile(partial), ARCHIVE);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("refuses an archive the pin has another digest for, and installs nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const requests: Array<string> = [];

      const { runtime, partial, staging, reason } = yield* install(requests, {
        pinned: NodeCrypto.createHash("sha256").update("another build").digest("hex"),
      });

      assert.strictEqual(reason, "checksum");
      assert.deepStrictEqual(requests, ["whole"]);
      assert.isFalse(yield* fs.exists(path.join(runtime, pin.version)));
      assert.isFalse(yield* fs.exists(partial));
      assert.isFalse(yield* fs.exists(staging));
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

  it.live("installs once when two installs of the version start at once, and both use it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const source = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(source, "t3"), "the engine");
      const archiveFile = path.join(source, "engine.tar.gz");
      NodeChildProcess.execFileSync("tar", ["-czf", archiveFile, "-C", source, "t3"]);
      const archive = yield* fs.readFile(archiveFile);
      let downloads = 0;
      const releaseServer = HttpClient.make((request) =>
        Effect.sync(() => {
          downloads += 1;
          return HttpClientResponse.fromWeb(request, new Response(archive, { status: 200 }));
        }),
      );
      const files = yield* makePrivateFiles(() => Effect.succeed(true));
      const installOnce = ensureInstalled({
        home,
        platform: "linux",
        arch: "x64",
        sha256: { "linux-x64": NodeCrypto.createHash("sha256").update(archive).digest("hex") },
        files,
      }).pipe(Effect.provideService(HttpClient.HttpClient, releaseServer));

      const executables = yield* Effect.all([installOnce, installOnce], { concurrency: 2 });

      const runtime = path.join(home, "j3", "runtime");
      const executable = path.join(runtime, pin.version, "t3");
      assert.deepStrictEqual(executables, [executable, executable]);
      assert.strictEqual(downloads, 1);
      assert.strictEqual(yield* fs.readFileString(executable), "the engine");
      assert.deepStrictEqual((yield* fs.readDirectory(runtime)).sort(), [
        pin.version,
        `${pin.version}.lock`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("a download's progress", () => {
  it.effect("is reported when it starts and when it ends, not with every chunk", () =>
    Effect.gen(function* () {
      const { progress } = yield* install([], { sending: { sized: true, chunk: 1 } });

      // The test clock stands still: no second passes between chunks.
      assert.deepStrictEqual(progress, [
        { receivedBytes: 0, totalBytes: ARCHIVE.length },
        { receivedBytes: ARCHIVE.length, totalBytes: ARCHIVE.length },
      ]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.live("is reported again once a second has passed while it runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const files = yield* makePrivateFiles(() => Effect.succeed(true));
      // Ten bytes at once, ten more after a second and a bit, then the rest at once.
      const slow = HttpClient.make((request) => {
        const body = Stream.make(ARCHIVE.slice(0, 10)).pipe(
          Stream.concat(
            Stream.fromEffect(Effect.as(Effect.sleep("1100 millis"), ARCHIVE.slice(10, 20))),
          ),
          Stream.concat(Stream.make(ARCHIVE.slice(20))),
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(Stream.toReadableStream(body), {
              headers: { "content-length": String(ARCHIVE.length) },
            }),
          ),
        );
      });
      const progress: Array<EngineInstallProgress> = [];

      yield* ensureInstalled({
        home,
        platform: "linux",
        arch: "x64",
        sha256: { "linux-x64": DIGEST },
        files,
        onProgress: (reported) => Effect.sync(() => progress.push(reported)),
      }).pipe(Effect.provideService(HttpClient.HttpClient, slow), Effect.exit);

      assert.deepStrictEqual(
        progress.map(({ receivedBytes }) => receivedBytes),
        [0, 20, ARCHIVE.length],
      );
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("has no total when the release server does not say the size", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resumed = yield* install([], {
        sending: { sized: false },
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(resumed.progress, [
        { receivedBytes: 10, totalBytes: null },
        { receivedBytes: ARCHIVE.length, totalBytes: null },
      ]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("installTracked", () => {
  it.effect("shows the download in the state, and clears it once installed", () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
      const seen: Array<ProcessState> = [];
      const look = SubscriptionRef.get(state).pipe(Effect.map((now) => seen.push(now)));
      let attempts = 0;

      const executable = yield* installTracked({
        state,
        retry: Schedule.recurs(1),
        install: (onProgress) =>
          Effect.gen(function* () {
            attempts += 1;
            yield* look;
            if (attempts === 1) {
              yield* onProgress({ receivedBytes: 4, totalBytes: 10 });
              yield* look;
              return yield* new EngineInstallFailed({ reason: "download", version: pin.version });
            }
            yield* onProgress({ receivedBytes: 10, totalBytes: 10 });
            yield* look;
            return "/engine/t3";
          }),
      });
      yield* look;

      assert.strictEqual(executable, "/engine/t3");
      assert.deepStrictEqual(seen, [
        { _tag: "starting" },
        { _tag: "starting", install: { receivedBytes: 4, totalBytes: 10 } },
        // Waiting to try again, the failure shows; the next download replaces it.
        { _tag: "unavailable", reason: "install-failed" },
        { _tag: "starting", install: { receivedBytes: 10, totalBytes: 10 } },
        { _tag: "starting" },
      ]);
    }),
  );
});
