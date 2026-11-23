// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The pin holds a SHA-256 of the archive, computed here as the install checks it; a folder swapped for a link mid-download takes node:fs, from inside the response body; a real archive to unpack is made with tar.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as PlatformError from "effect/PlatformError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  type DownloadEvent,
  EngineInstallFailed,
  ensureInstalled,
  installTracked,
  makeProgressLog,
} from "./Install.ts";
import { pin } from "./Pin.ts";
import { makePrivateFiles } from "./PrivateFiles.ts";
import type { ProcessState } from "./Supervisor.ts";

/** The release's archive. Not a real one: the install stops at unpacking it. */
const ARCHIVE = new TextEncoder().encode("the pinned engine release, byte for byte");
const DIGEST = NodeCrypto.createHash("sha256").update(ARCHIVE).digest("hex");

/** How far a download has come, as `onDownload` hears it. */
const progress = (receivedBytes: number, totalBytes: number | null): DownloadEvent => ({
  _tag: "progress",
  progress: { receivedBytes, totalBytes },
});

/** A download's end, as `onDownload` hears it. */
const downloaded = (receivedBytes: number, totalBytes: number | null): DownloadEvent => ({
  _tag: "downloaded",
  progress: { receivedBytes, totalBytes },
});

/** How the release server sends the archive. */
interface Sending {
  /** Whether it says the archive's size: `Content-Length`, and a range's `Content-Range`. */
  readonly sized: boolean;
  /** Bytes per chunk of the body, or the whole rest in one. */
  readonly chunk?: number;
  /** Whether it answers a range with the whole archive, as `200`. */
  readonly ignoresRange?: boolean;
  /** A `Content-Length` it sends instead of the true one. */
  readonly contentLength?: string;
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
    const from = sending.ignoresRange === true ? 0 : Number(range?.[1] ?? 0);
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
          "content-length": sending.contentLength ?? String(rest.length),
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
    const events: Array<DownloadEvent> = [];
    const exit = yield* ensureInstalled({
      home,
      platform: "linux",
      arch: "x64",
      sha256: { "linux-x64": setup.pinned ?? DIGEST },
      files,
      onDownload: (event) => Effect.sync(() => events.push(event)),
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        release(requests, () => setup.afterArchive?.(workspace), setup.sending),
      ),
      Effect.exit,
    );
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return { ...workspace, events, reason: Option.getOrUndefined(error)?.reason };
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

      const { partial, events, reason } = yield* install(requests, {
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(requests, ["bytes=10-"]);
      // It counts what it had, of the size the range says.
      assert.deepStrictEqual(events, [
        progress(10, ARCHIVE.length),
        downloaded(ARCHIVE.length, ARCHIVE.length),
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
      const { events } = yield* install([], { sending: { sized: true, chunk: 1 } });

      // The test clock stands still: no second passes between chunks.
      assert.deepStrictEqual(events, [
        progress(0, ARCHIVE.length),
        downloaded(ARCHIVE.length, ARCHIVE.length),
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
      const events: Array<DownloadEvent> = [];

      yield* ensureInstalled({
        home,
        platform: "linux",
        arch: "x64",
        sha256: { "linux-x64": DIGEST },
        files,
        onDownload: (event) => Effect.sync(() => events.push(event)),
      }).pipe(Effect.provideService(HttpClient.HttpClient, slow), Effect.exit);

      assert.deepStrictEqual(events, [
        progress(0, ARCHIVE.length),
        progress(20, ARCHIVE.length),
        downloaded(ARCHIVE.length, ARCHIVE.length),
      ]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("has no total when the release server does not say the size", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resumed = yield* install([], {
        sending: { sized: false },
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(resumed.events, [
        progress(10, null),
        downloaded(ARCHIVE.length, null),
      ]);

      // A size too large to count exactly is no size.
      const huge = yield* install([], {
        sending: { sized: true, contentLength: "99999999999999999999" },
      });
      assert.deepStrictEqual(huge.events, [progress(0, null), downloaded(ARCHIVE.length, null)]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("starts over from 0 when a range is answered with the whole archive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requests: Array<string> = [];

      const { partial, events } = yield* install(requests, {
        sending: { sized: true, ignoresRange: true },
        prepare: ({ partial }) => fs.writeFile(partial, ARCHIVE.slice(0, 10)),
      });

      assert.deepStrictEqual(requests, ["bytes=10-"]);
      // The size is its Content-Length, not what the partial held added to it.
      assert.deepStrictEqual(events, [
        progress(0, ARCHIVE.length),
        downloaded(ARCHIVE.length, ARCHIVE.length),
      ]);
      assert.deepStrictEqual(yield* fs.readFile(partial), ARCHIVE);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("is logged at its end, also when its size is not known", () =>
    Effect.gen(function* () {
      const log = yield* makeProgressLog();
      const lines = yield* Effect.forEach(
        [progress(0, null), progress(5_000_000, null), downloaded(9_000_000, null)],
        log,
      );

      assert.deepStrictEqual(lines.map(Option.getOrNull), [
        "Downloading the engine: 0 MB",
        null,
        "Downloaded the engine: 9 MB",
      ]);
    }),
  );
});

describe("installTracked", () => {
  it.effect("shows the download in the state, and clears it once the download ends", () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
      const seen: Array<ProcessState> = [];
      const look = SubscriptionRef.get(state).pipe(Effect.map((now) => seen.push(now)));
      const logged: Array<string> = [];
      const recordInfo = Logger.layer([
        Logger.make(({ message, logLevel }) => {
          const [first] = Array.isArray(message) ? message : [message];
          if (logLevel === "Info" && typeof first === "string") logged.push(first);
        }),
      ]);
      let attempts = 0;

      const executable = yield* installTracked({
        state,
        retry: Schedule.recurs(1),
        install: (onDownload) =>
          Effect.gen(function* () {
            attempts += 1;
            yield* look;
            if (attempts === 1) {
              yield* onDownload(progress(4_000_000, 10_000_000));
              yield* look;
              return yield* new EngineInstallFailed({ reason: "download", version: pin.version });
            }
            yield* onDownload(progress(2_000_000, 10_000_000));
            yield* look;
            yield* onDownload(downloaded(10_000_000, 10_000_000));
            // Checked and unpacked from here: the download no longer shows.
            yield* look;
            return "/engine/t3";
          }),
      }).pipe(Effect.provide(recordInfo));
      yield* look;

      assert.strictEqual(executable, "/engine/t3");
      assert.deepStrictEqual(seen, [
        { _tag: "starting" },
        { _tag: "starting", install: { receivedBytes: 4_000_000, totalBytes: 10_000_000 } },
        // Waiting to try again, the failure shows; the next download replaces it.
        { _tag: "unavailable", reason: "install-failed" },
        { _tag: "starting", install: { receivedBytes: 2_000_000, totalBytes: 10_000_000 } },
        { _tag: "starting" },
        { _tag: "starting" },
      ]);
      // The retry's first line is logged, though no ten seconds passed since the last.
      assert.deepStrictEqual(logged, [
        "Downloading the engine: 4 of 10 MB",
        "Downloading the engine: 2 of 10 MB",
        "Downloaded the engine: 10 MB",
      ]);
    }),
  );
});
