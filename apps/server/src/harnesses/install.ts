// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HarnessTask } from "@j3-bots/contracts";
import { platformErrorCode, whileHeld } from "@j3-bots/processes";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Layout } from "../Layout.ts";
import type { DistributionClient, Release } from "./distributions.ts";
import { fileFailed, HarnessFailed } from "./failure.ts";
import { sha256 } from "../hash.ts";
import { writeInPlace } from "../home/inPlace.ts";
import { type CopyLayout, InnerPath, type InstalledCopy } from "./layout.ts";

// One release of a harness, from its download to an installed, checked copy
// in `versions/<version>/` (`layout.ts`). Nothing is made executable, and
// nothing unpacked, before the whole download has the SHA-256 its maker
// publishes; a copy is installed only once it ran and said its version.
//
// It runs for the first time in its version's folder, not where it was
// unpacked: Windows refuses to move a folder while another program holds a
// file in it, and a new executable is held for a moment after its first run
// (by a scanner, or by its own process as it ends). Made after that run, the
// move failed the install whenever something still held the copy (decision
// 0064). A rename or a removal Windows refuses while another program holds a
// file is tried again for a while (`whileHeld`); each file failure says what
// it comes down to (`fileFailed`).

/** No harness's download is near this; one that passes it is not the release. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** How often, at most, a download reports how far it has come, besides when it starts. */
const PROGRESS_INTERVAL_MS = 1_000;

/** Runs a copy once and answers the version it says it is, if it ran and said one. */
export type Probe = (executable: string) => Effect.Effect<Option.Option<string>>;

const unreachable = () => new HarnessFailed({ reason: "unreachable" });
const checksum = () => new HarnessFailed({ reason: "checksum" });
const check = () => new HarnessFailed({ reason: "check" });

/** What Codex's package says of itself, in `codex-package.json` at its root. */
const CodexPackage = Schema.Struct({ version: Schema.String, entrypoint: InnerPath });

/** The first version number in what a harness prints for `--version`, as `2.1.326 (Claude Code)` or `codex-cli 0.172.0`. */
export const versionIn = (output: string): Option.Option<string> =>
  Option.fromNullishOr(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1]);

/**
 * Installs `release` into `layout`'s `versions/<version>/`, reporting what it
 * does on `report`. Resumes a download cut off before, from its `.partial`;
 * an interrupted one keeps what arrived for the next attempt. A download
 * whose digest is wrong, a package that does not unpack, or a copy that does
 * not run and say its version leaves nothing behind.
 */
export const installRelease = Effect.fn("harnesses.installRelease")(function* (input: {
  readonly release: Release;
  readonly layout: CopyLayout;
  readonly files: Layout["Service"];
  readonly client: DistributionClient;
  readonly probe: Probe;
  readonly platform: string;
  readonly report: (task: HarnessTask) => Effect.Effect<void>;
}) {
  const { release, layout, files, report, platform } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const partial = layout.partial(release.version);
  const staging = layout.staging(release.version);
  const target = layout.version(release.version);
  const { writeFailed, remove, rename } = fileSteps(fs, platform);
  // Every location is checked to be inside the home, links resolved, before it is written.
  const checked = (location: string) => files.writable(location).pipe(Effect.catch(writeFailed));

  const root = yield* checked(layout.root);
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.catch(writeFailed));
  yield* checked(partial);

  const existing = yield* fs.stat(partial).pipe(Effect.option);
  const kept =
    Option.isSome(existing) && existing.value.type === "File" ? Number(existing.value.size) : 0;
  // A partial longer than the release is not part of it.
  const have = release.size !== null && kept > release.size ? 0 : kept;
  if (have === 0 && kept > 0) yield* remove(partial);

  const limit = release.size ?? MAX_DOWNLOAD_BYTES;
  if (release.size === null || have < release.size) {
    yield* Effect.gen(function* () {
      // The answer belongs to this scope, which ends it however the download
      // ends. Unscoped, a download interrupted after the answer came but
      // before its body was read, as by the server's stop, left it open until
      // a garbage collection: bytes still arriving that kept the process alive.
      const response = yield* HttpClient.withScope(input.client)
        .execute(
          HttpClientRequest.get(release.url).pipe(
            have > 0
              ? HttpClientRequest.setHeader("range", `bytes=${have}-`)
              : (request) => request,
          ),
        )
        .pipe(Effect.mapError(unreachable));
      // 416: what was kept is the whole file already; the digest says whether it is.
      if (response.status !== 416) {
        const appending = have > 0 && response.status === 206;
        if (!appending && response.status !== 200) return yield* unreachable();
        const from = appending ? have : 0;
        const length = Number(response.headers["content-length"]);
        const totalBytes =
          release.size ?? (Number.isSafeInteger(length) && length >= 0 ? from + length : null);
        let received = from;
        let reportedAt: number | null = null;
        yield* report({ _tag: "downloading", receivedBytes: received, totalBytes });
        const arriving = response.stream.pipe(
          Stream.mapError(unreachable),
          Stream.mapEffect((chunk) =>
            Effect.gen(function* () {
              received += chunk.byteLength;
              // More than the maker said it is: not the release.
              if (received > limit) return yield* checksum();
              const now = yield* Clock.currentTimeMillis;
              if (reportedAt === null || now - reportedAt >= PROGRESS_INTERVAL_MS) {
                reportedAt = now;
                yield* report({ _tag: "downloading", receivedBytes: received, totalBytes });
              }
              return chunk;
            }),
          ),
        );
        // Written in place, so that a download cut off resumes; a link at its name is refused.
        // A write that fails is the file system's, not the network's.
        yield* writeInPlace(partial, appending, arriving).pipe(
          Effect.catchTag("InPlaceFailure", writeFailed),
        );
      }
    }).pipe(Effect.scoped);
  }

  yield* report({ _tag: "verifying" });
  // Checked again before it is read: the download may have taken long.
  yield* checked(partial);
  const hash = sha256();
  let size = 0;
  yield* fs.stream(partial).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ),
    Effect.catch(writeFailed),
  );
  if ((release.size !== null && size !== release.size) || hash.hex() !== release.sha256) {
    // A wrong download would fail the same way forever: the next attempt starts over.
    yield* remove(partial);
    return yield* checksum();
  }

  yield* checked(staging);
  yield* remove(staging);
  yield* fs.makeDirectory(staging, { mode: 0o700 }).pipe(Effect.catch(writeFailed));
  const inner = yield* unpack(input, partial, staging).pipe(
    Effect.tapError(() => remove(staging).pipe(Effect.ignore)),
  );

  // Moved into place before anything in it runs (above).
  yield* checked(target);
  yield* fs
    .makeDirectory(layout.versions, { recursive: true, mode: 0o700 })
    .pipe(Effect.catch(writeFailed));
  yield* remove(target);
  yield* rename(staging, target);
  const executable = path.join(target, ...inner.split("/"));
  const said = yield* input.probe(executable);
  if (Option.isNone(said) || said.value !== release.version) {
    yield* Effect.logWarning("A downloaded harness did not say the version its maker listed", {
      listed: release.version,
      said: Option.getOrNull(said),
    });
    // What the copy did matters, not its removal: one left is pruned later.
    yield* remove(target).pipe(Effect.ignore);
    return yield* check();
  }
  yield* remove(partial);
  return { version: release.version, executable, inner } satisfies InstalledCopy;
});

/**
 * How an install fails for a file: a write, read or check that fails says
 * why (`fileFailed`); a rename or a removal is tried again while Windows says
 * another program holds the file (`whileHeld`), and then says why.
 */
const fileSteps = (fs: FileSystem.FileSystem, platform: string) => {
  const movedFailed = fileFailed(platform, true);
  const patiently = <A>(operation: Effect.Effect<A, PlatformError.PlatformError>) =>
    whileHeld(operation, { platform, codeOf: platformErrorCode }).pipe(Effect.catch(movedFailed));
  return {
    writeFailed: fileFailed(platform, false),
    remove: (location: string) => patiently(fs.remove(location, { recursive: true, force: true })),
    rename: (from: string, to: string) => patiently(fs.rename(from, to)),
  };
};

/**
 * The system's own `tar`: on Windows, the one in its `System32` folder,
 * since another on `PATH`, as Git for Windows' GNU tar, reads a path with a
 * drive letter as a remote host's.
 */
const systemTar = Effect.fnUntraced(function* (platform: string) {
  if (platform !== "win32") return "tar";
  const root = yield* Config.String("SystemRoot").pipe(
    Config.withDefault("C:\\Windows"),
    Effect.orElseSucceed(() => "C:\\Windows"),
  );
  return `${root}\\System32\\tar.exe`;
});

/**
 * Puts the checked download `archive` into the empty folder `into`, and
 * answers the executable's path inside it: the file itself for Claude Code,
 * made executable; Codex's package unpacked by the system's `tar`, which
 * every system it ships for has (Windows' since Windows 10), its entrypoint
 * the one its `codex-package.json` names, for the version listed.
 */
const unpack = Effect.fnUntraced(function* (
  input: { readonly release: Release; readonly platform: string },
  archive: string,
  into: string,
): Effect.fn.Return<
  string,
  HarnessFailed,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { release } = input;
  switch (release.format) {
    case "executable": {
      const { writeFailed, rename } = fileSteps(fs, input.platform);
      const file = path.join(into, release.fileName);
      yield* rename(archive, file);
      if (input.platform !== "win32") {
        yield* fs.chmod(file, 0o755).pipe(Effect.catch(writeFailed));
      }
      return release.fileName;
    }
    case "tar.gz": {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exit = yield* spawner
        .exitCode(
          ChildProcess.make(yield* systemTar(input.platform), ["-xzf", archive, "-C", into], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
            killSignal: "SIGTERM",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Running tar to unpack a harness failed", cause),
          ),
          Effect.orElseSucceed(() => -1),
        );
      // The archive had the maker's checksum: a tar that fails could not
      // write what it unpacked, and says why on the server's stderr.
      if (exit !== 0) return yield* new HarnessFailed({ reason: "files" });
      const described = yield* fs
        .readFileString(path.join(into, "codex-package.json"))
        .pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CodexPackage))),
          Effect.mapError(check),
        );
      if (described.version !== release.version) return yield* check();
      const entry = path.join(into, ...described.entrypoint.split("/"));
      const info = yield* fs.stat(entry).pipe(Effect.mapError(check));
      if (info.type !== "File") return yield* check();
      return described.entrypoint;
    }
  }
});
