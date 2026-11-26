// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HarnessTask } from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Layout } from "../Layout.ts";
import type { DistributionClient, Release } from "./distributions.ts";
import { HarnessFailed } from "./failure.ts";
import { sha256 } from "./hash.ts";
import { writeInPlace } from "./inPlace.ts";
import { type CopyLayout, InnerPath, type InstalledCopy } from "./layout.ts";

// One release of a harness, from its download to an installed, checked copy
// in `versions/<version>/` (`layout.ts`). Nothing is made executable, and
// nothing unpacked, before the whole download has the SHA-256 its maker
// publishes; a copy is installed only once it ran and said its version.

/** No harness's download is near this; one that passes it is not the release. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** How often, at most, a download reports how far it has come, besides when it starts. */
const PROGRESS_INTERVAL_MS = 1_000;

/** Runs a copy once and answers the version it says it is, if it ran and said one. */
export type Probe = (executable: string) => Effect.Effect<Option.Option<string>>;

const storage = () => new HarnessFailed({ reason: "storage" });
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
  const { release, layout, files, report } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const partial = layout.partial(release.version);
  const staging = layout.staging(release.version);
  const target = layout.version(release.version);
  const remove = (location: string) =>
    fs.remove(location, { recursive: true, force: true }).pipe(Effect.mapError(storage));

  // Every location is checked to be inside the home, links resolved, before it is written.
  const root = yield* files.writable(layout.root).pipe(Effect.mapError(storage));
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(storage));
  yield* files.writable(partial).pipe(Effect.mapError(storage));

  const existing = yield* fs.stat(partial).pipe(Effect.option);
  const kept =
    Option.isSome(existing) && existing.value.type === "File" ? Number(existing.value.size) : 0;
  // A partial longer than the release is not part of it.
  const have = release.size !== null && kept > release.size ? 0 : kept;
  if (have === 0 && kept > 0) yield* remove(partial);

  const limit = release.size ?? MAX_DOWNLOAD_BYTES;
  if (release.size === null || have < release.size) {
    const response = yield* input.client
      .execute(
        HttpClientRequest.get(release.url).pipe(
          have > 0 ? HttpClientRequest.setHeader("range", `bytes=${have}-`) : (request) => request,
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
      yield* writeInPlace(partial, appending, arriving).pipe(
        // A write that fails is the disk's, not the network's.
        Effect.catchTag("InPlaceFailure", (error) =>
          Effect.logWarning("Writing a harness download failed", {
            file: error.file,
            code: error.code,
          }).pipe(Effect.andThen(Effect.fail(storage()))),
        ),
      );
    }
  }

  yield* report({ _tag: "verifying" });
  // Checked again before it is read: the download may have taken long.
  yield* files.writable(partial).pipe(Effect.mapError(storage));
  const hash = sha256();
  let size = 0;
  yield* fs.stream(partial).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ),
    Effect.mapError(storage),
  );
  if ((release.size !== null && size !== release.size) || hash.hex() !== release.sha256) {
    // A wrong download would fail the same way forever: the next attempt starts over.
    yield* remove(partial);
    return yield* checksum();
  }

  yield* files.writable(staging).pipe(Effect.mapError(storage));
  yield* remove(staging);
  yield* fs.makeDirectory(staging, { mode: 0o700 }).pipe(Effect.mapError(storage));
  const inner = yield* unpack(input, partial, staging).pipe(Effect.tapError(() => remove(staging)));
  const executable = path.join(staging, ...inner.split("/"));
  const said = yield* input.probe(executable);
  if (Option.isNone(said) || said.value !== release.version) {
    yield* Effect.logWarning("A downloaded harness did not say the version its maker listed", {
      listed: release.version,
      said: Option.getOrNull(said),
    });
    yield* remove(staging);
    return yield* check();
  }

  yield* files.writable(target).pipe(Effect.mapError(storage));
  yield* fs
    .makeDirectory(layout.versions, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(storage));
  yield* remove(target);
  yield* fs.rename(staging, target).pipe(Effect.mapError(storage));
  yield* remove(partial);
  return {
    version: release.version,
    executable: path.join(target, ...inner.split("/")),
    inner,
  } satisfies InstalledCopy;
});

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
      const file = path.join(into, release.fileName);
      yield* fs.rename(archive, file).pipe(Effect.mapError(storage));
      if (input.platform !== "win32") {
        yield* fs.chmod(file, 0o755).pipe(Effect.mapError(storage));
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
      if (exit !== 0) return yield* check();
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
