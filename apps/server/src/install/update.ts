// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AdminClient } from "../admin/AdminClient.ts";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { holdHome, holdLock, shellWord } from "../home/Home.ts";
import * as Installation from "../installation.ts";
import { isWithin, realLocation } from "../paths.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import {
  checkOwnFolder,
  installedVersions,
  installFolder,
  launchedRelease,
  recordedLauncher,
  startedRelease,
  startsInstall,
  VERSIONS,
  writeLauncher,
} from "./layout.ts";
import { fetchRelease, isRelease, targetVersion } from "./release.ts";
import {
  backupsElsewhere,
  listSnapshots,
  markRestoring,
  pruneSnapshots,
  restoreBytes,
  restoreSnapshot,
  rollbackSnapshot,
  type Snapshot,
  type SnapshotRelease,
  snapshotBytes,
  takeSnapshot,
  unfinishedRollback,
  unmarkRestoring,
  UPDATE_LOCK,
} from "./snapshot.ts";
import { rollBackOver, type Side, StepFailed, switchOver, type SwitchOutcome } from "./switch.ts";

// `j3-bots update` and `j3-bots update --rollback`, run by the release that is
// installed, which can always start itself again
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md). An
// update prepares without changing anything (the release downloaded and
// checked into `versions/`, its engine fetched), then switches (`switch.ts`),
// then keeps two of everything: releases, snapshots and engine runtimes.
//
// With the service installed, the release that runs is the one its unit
// starts, not the one the command runs: an update cut off after the new
// release's `service install` leaves the unit on the new release and the
// command on the old one, and the next `update` to that release only points
// the command at it.
//
// An update or a rollback holds `<home>/backups/update.lock` from start to
// end, so a second one is refused, and reads what runs and whether a
// rollback is unfinished only once it holds it. It holds the home's
// `server.lock`, which a running server holds, while it copies the databases
// or puts them back, so no server, in or outside the service, runs on them
// then.

/** How long a started release has to answer as itself with its engine ready. Its engine is fetched already. */
const READY_WITHIN = Duration.minutes(5);

/** Free space an update needs where the data directory is, beyond twice the files it copies. */
const HOME_ROOM = 1024 ** 3;

/** Free space a release needs where the install is: its archive and its unpacked folder. */
const RELEASE_ROOM = 512 * 1024 ** 2;

/** How many releases, snapshots and engine runtimes an update keeps. */
const KEEP = 2;

/** Why an update or a rollback did not start. Nothing was changed. */
class UpdateRefused extends Schema.TaggedError<UpdateRefused>()("UpdateRefused", {
  reason: Schema.Literals([
    "checkout",
    "unpacked",
    "no-command",
    "no-systemd",
    "server-outside",
    "disk",
    "engine-fetch",
    "no-snapshot",
    "snapshot-elsewhere",
    "release-gone",
    "restore-unfinished",
    "busy",
    "backups-elsewhere",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "checkout":
        return "This j3-bots runs from a checkout, which updates with Git: `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`, then `j3-bots service install`.";
      case "unpacked":
        return `This release in ${this.detail} was not installed by install.sh, so there is no install to update. Install J3 Bots with install.sh, or replace this folder yourself.`;
      case "no-command":
        return `The install in ${this.detail} has no record of its j3-bots command. Run install.sh again for this version to restore it.`;
      case "no-systemd":
        return "The service is installed, but there is no systemd user manager to stop and start it with. Log in to a systemd session as this user (not with sudo), then run this again.";
      case "server-outside":
        return `A J3 Bots server outside the service is running for ${this.detail}. Stop it, then run this again.`;
      case "disk":
        return this.detail;
      case "engine-fetch":
        return `J3 Bots ${this.detail} could not install the engine it is pinned to: see above. The release that runs now was not touched.`;
      case "no-snapshot":
        return `No update has taken a snapshot in ${this.detail} yet, so there is nothing to roll back to.`;
      case "snapshot-elsewhere":
        return this.detail;
      case "release-gone":
        return `J3 Bots ${this.detail}, the release the snapshot to roll back to was taken from, is no longer in this install. Install it with install.sh --version ${this.detail} after \`j3-bots uninstall\`, or put the snapshot back by hand.`;
      case "restore-unfinished":
        return `A rollback to the snapshot in ${this.detail} has not finished, so the service stays disabled and no other release may run on the data directory. \`j3-bots update --rollback\` finishes it. Nothing was changed.`;
      case "busy":
        return `Another \`j3-bots update\` or \`j3-bots update --rollback\` is running for ${this.detail}. Wait for it to end, then run this again. Nothing was changed.`;
      case "backups-elsewhere":
        return this.detail;
    }
  }
}

/** The install this copy of J3 Bots runs from, and what it runs with. */
interface Installed {
  readonly install: string;
  /** The j3-bots command it recorded. */
  readonly launcher: string;
  /** The release that runs: the one the unit starts, with the service installed; else the command's. */
  readonly release: Installation.ReleaseManifest;
  /** The folder of the release that runs, in `versions/`. */
  readonly root: string;
  /** The release folder the command runs, when it is a command install.sh or an update wrote. */
  readonly command: Option.Option<string>;
  /** The data directory: the service's, else this shell's. */
  readonly home: string;
  /** Whether a systemd unit runs this install. */
  readonly service: boolean;
  /** The environment a release's commands run with: the service's home and `PATH`, none of this shell's overrides. */
  readonly environment: Record<string, string | undefined>;
}

const located = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const systemd = yield* Systemd;
  const host = yield* Host;
  const installation = yield* Installation.installation;
  const { layout } = installation;
  if (layout._tag === "checkout")
    return yield* new UpdateRefused({ reason: "checkout", detail: "" });
  const install = yield* installFolder(installation);
  if (Option.isNone(install)) {
    return yield* new UpdateRefused({ reason: "unpacked", detail: layout.root });
  }
  const launcher = yield* recordedLauncher(install.value);
  if (Option.isNone(launcher)) {
    return yield* new UpdateRefused({ reason: "no-command", detail: install.value });
  }
  const unitFile = yield* Unit.unitPath;
  const unit = yield* fs.readFileString(unitFile).pipe(Effect.option);
  const own =
    Option.isSome(unit) && (yield* startsInstall(Unit.execStartOf(unit.value), install.value));
  if (own && !(yield* systemd.available)) {
    return yield* new UpdateRefused({ reason: "no-systemd", detail: "" });
  }
  const environment = own && Option.isSome(unit) ? Unit.environmentOf(unit.value) : new Map();
  const home = environment.get("J3_HOME") ?? (yield* ServerConfig.resolveHome);
  // The release the unit starts, when it names one that is still a release.
  const started =
    own && Option.isSome(unit)
      ? yield* startedRelease(Unit.execStartOf(unit.value), install.value)
      : Option.none<string>();
  const startedManifest = Option.isSome(started)
    ? Option.map(yield* releaseOf(started.value), (manifest) => ({
        root: started.value,
        manifest,
      }))
    : Option.none();
  const running = Option.getOrElse(startedManifest, () => ({
    root: layout.root,
    manifest: layout.manifest,
  }));
  return {
    install: install.value,
    launcher: launcher.value,
    release: running.manifest,
    root: running.root,
    command: yield* launchedRelease(launcher.value),
    home,
    service: own,
    environment: {
      ...Object.fromEntries(ServerConfig.SHELL_OVERRIDES.map((name) => [name, undefined])),
      J3_HOME: home,
      PATH: environment.get("PATH") ?? host.searchPath,
    },
  } satisfies Installed;
});

/**
 * Runs the j3-bots of the release at `root` with `args`: whether it
 * succeeded. Its output is relayed through this process line by line, as it
 * comes with `relay`, or only when it fails with `on-failure`, so a terminal
 * that hung up never fails it. It runs in a session of its own, so a hangup
 * never reaches it either.
 */
const runRelease = Effect.fn("update.runRelease")(function* (
  installed: Installed,
  root: string,
  args: ReadonlyArray<string>,
  output: "relay" | "on-failure",
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const kept: Array<readonly [line: string, error: boolean]> = [];
  const lines = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>, error: boolean) =>
    stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        output === "relay"
          ? error
            ? Console.error(line)
            : Console.log(line)
          : Effect.sync(() => kept.push([line, error])),
      ),
    );
  const exit = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(path.join(root, "bin", "j3-bots"), [...args], {
          env: installed.environment,
          extendEnv: true,
          detached: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [, , code] = yield* Effect.all(
        [lines(handle.stdout, false), lines(handle.stderr, true), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return Number(code);
    }),
  ).pipe(Effect.orElseSucceed(() => -1));
  if (exit !== 0) {
    yield* Effect.forEach(
      kept,
      ([line, error]) => (error ? Console.error(line) : Console.log(line)),
      {
        discard: true,
      },
    );
  }
  return exit === 0;
});

/**
 * Holds `<home>/backups/update.lock` for the scope, or fails while another
 * update or rollback holds it.
 */
const holdUpdate = Effect.fn("update.holdUpdate")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const backups = path.join(home, HOME_ENTRIES.backups);
  yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
  yield* holdLock(
    path.join(backups, UPDATE_LOCK),
    () => new UpdateRefused({ reason: "busy", detail: home }),
  );
});

/** Runs `effect` holding the home's `server.lock`, which a server outside the service may hold. */
const withHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.andThen(holdHome(home), effect)).pipe(
    Effect.catchTag("ServerAlreadyRunning", () =>
      Effect.fail(new UpdateRefused({ reason: "server-outside", detail: home })),
    ),
  );

/**
 * Whether the service's server runs, before anything is stopped. With none
 * running, the home's `server.lock` is tried: a server outside the service
 * that holds it fails this, since its files are copied and put back with no
 * server on them.
 */
const serviceRunning = Effect.fn("update.serviceRunning")(function* (installed: Installed) {
  if (installed.service) {
    const unit = yield* (yield* Systemd).unitState(Unit.UNIT_NAME);
    if (unit.active === "active") return true;
  }
  yield* withHome(installed.home, Effect.void);
  return false;
});

/**
 * Waits for the service's own server to answer as `version`, with its engine
 * ready, within `READY_WITHIN`. Only the version, the process and the
 * engine's state are read from its reply, so a newer release's reply reads.
 */
const awaitReady = Effect.fn("update.awaitReady")(function* (
  installed: Installed,
  version: string,
  step: StepFailed["step"],
) {
  const path = yield* Path.Path;
  const admin = yield* AdminClient;
  const systemd = yield* Systemd;
  const socket = path.join(installed.home, HOME_ENTRIES.adminSocket);
  const poll = Effect.gen(function* () {
    const unit = yield* systemd.unitState(Unit.UNIT_NAME);
    if (unit.active === "failed") return { _tag: "failed", reason: "the service failed" } as const;
    const answer = Option.flatten(yield* admin.readiness(socket).pipe(Effect.option));
    if (
      Option.isNone(answer) ||
      answer.value.version !== version ||
      !Option.contains(unit.mainPid, answer.value.pid)
    ) {
      return { _tag: "waiting" } as const;
    }
    switch (answer.value.engine.state._tag) {
      case "ready":
        return { _tag: "ready" } as const;
      case "incompatible":
        return {
          _tag: "failed",
          reason: "its engine is not the version it is pinned to",
        } as const;
      default:
        return { _tag: "waiting" } as const;
    }
  });
  const outcome = yield* poll.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (state) => state._tag !== "waiting",
    }),
    Effect.timeoutOption(READY_WITHIN),
  );
  if (Option.isSome(outcome) && outcome.value._tag === "ready") return;
  return yield* new StepFailed({
    step,
    reason:
      Option.isSome(outcome) && outcome.value._tag === "failed"
        ? `J3 Bots ${version} did not start: ${outcome.value.reason}`
        : `J3 Bots ${version} did not answer with its engine ready within ${Duration.format(READY_WITHIN)}`,
  });
});

/** What the steps of the switch run with. */
type SwitchServices =
  | FileSystem.FileSystem
  | Path.Path
  | Systemd
  | AdminClient
  | ChildProcessSpawner.ChildProcessSpawner;

/** The steps that stop, start and point at the two releases of an install. */
const releaseSteps = (
  installed: Installed,
  releases: Record<Side, { readonly version: string; readonly root: string }>,
) => ({
  stop: Effect.gen(function* () {
    yield* (yield* Systemd).stop(Unit.UNIT_NAME);
  }).pipe(Effect.mapError((cause) => new StepFailed({ step: "stop", reason: cause.message }))),
  disable: Effect.gen(function* () {
    const systemd = yield* Systemd;
    yield* systemd.stop(Unit.UNIT_NAME);
    yield* systemd.disableAndStop(Unit.UNIT_NAME);
  }).pipe(Effect.mapError((cause) => new StepFailed({ step: "stop", reason: cause.message }))),
  start: (side: Side) =>
    runRelease(installed, releases[side].root, ["service", "install"], "on-failure").pipe(
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : Effect.fail(
              new StepFailed({
                step: side === "new" ? "start-new" : "start-old",
                reason: `\`j3-bots service install\` of J3 Bots ${releases[side].version} failed: see above`,
              }),
            ),
      ),
    ),
  ready: (side: Side) =>
    awaitReady(installed, releases[side].version, side === "new" ? "await-new" : "await-old"),
  mark: (snapshot: Snapshot) =>
    markRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "mark", reason: cause.message })),
    ),
  restore: (snapshot: Snapshot) =>
    withHome(installed.home, restoreSnapshot(installed.home, snapshot)).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "restore", reason: cause.message })),
    ),
  unmark: (snapshot: Snapshot) =>
    unmarkRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "unmark", reason: cause.message })),
    ),
  pointCommand: (side: Side) =>
    writeLauncher({
      install: installed.install,
      launcher: installed.launcher,
      release: releases[side].root,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StepFailed({
            step: "command",
            reason: `${installed.launcher} could not be pointed at J3 Bots ${releases[side].version}: ${cause.message}`,
          }),
      ),
    ),
});

/** Bytes free where `location` is, or none when that cannot be read. */
const roomFor = Effect.fn("update.roomFor")(function* (
  location: string,
  needed: number,
  what: string,
) {
  const free = yield* (yield* Host).freeSpace(location);
  if (Option.isSome(free) && free.value < needed) {
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return yield* new UpdateRefused({
      reason: "disk",
      detail: `${what} needs ${gb(needed)} free where ${location} is, and ${gb(free.value)} is. Free some space, then run this again. Nothing was changed.`,
    });
  }
});

/** What the prepared release is. */
const releaseOf = Effect.fn("update.releaseOf")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .readFileString(path.join(root, Installation.RELEASE_MANIFEST))
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Installation.ReleaseManifest)),
      ),
      Effect.option,
    );
});

/** Keeps the `KEEP` releases, snapshots and engine runtimes an update leaves; a failure here only warns. */
const prune = Effect.fn("update.prune")(function* (
  installed: Installed,
  from: SnapshotRelease,
  to: SnapshotRelease,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const folder of yield* installedVersions(installed.install)) {
    const version = path.basename(folder);
    if (version === from.version || version === to.version) continue;
    if (yield* isRelease(folder)) yield* fs.remove(folder, { recursive: true });
  }
  yield* pruneSnapshots(installed.home, KEEP);
  if (from.engine !== undefined && to.engine !== undefined) {
    const realHome = Option.getOrElse(yield* realLocation(installed.home), () => installed.home);
    yield* EngineLive.pruneRuntimes({
      home: path.join(installed.home, HOME_ENTRIES.engine),
      keep: [from.engine, to.engine],
      isPrivate: (location) =>
        realLocation(location).pipe(
          Effect.map((real) => Option.isSome(real) && isWithin(realHome, real.value)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    });
  }
});

type UpdateResult =
  | { readonly _tag: "current"; readonly version: string }
  /** The service ran `version` already; the command now runs it too. */
  | { readonly _tag: "repointed"; readonly version: string }
  | { readonly _tag: "declined" }
  | {
      readonly _tag: "switched";
      readonly from: string;
      readonly to: string;
      readonly service: boolean;
      readonly outcome: SwitchOutcome<Snapshot>;
      /** Why keeping two of everything failed, which leaves only more on disk. */
      readonly pruning: Option.Option<string>;
    };

/** Fails while a rollback has not finished: only `--rollback` may change the home then. */
const checkNoUnfinishedRollback = Effect.fn("update.checkNoUnfinishedRollback")(function* (
  home: string,
) {
  const unfinished = yield* unfinishedRollback(home);
  if (Option.isSome(unfinished)) {
    return yield* new UpdateRefused({
      reason: "restore-unfinished",
      detail: unfinished.value.snapshot.folder,
    });
  }
});

/**
 * Fails when `<home>/backups` is on another filesystem than the data it
 * would put back, saying how to bring it back beside the data: until then a
 * rollback cannot move the home's files aside, and one this stopped half way
 * finishes once it is back.
 */
const checkBackupsBeside = Effect.fn("update.checkBackupsBeside")(function* (home: string) {
  const elsewhere = yield* backupsElsewhere(home);
  if (Option.isNone(elsewhere)) return;
  const { folder, backups, linkTo } = elsewhere.value;
  const where = Option.match(linkTo, {
    onSome: (target) => `${backups} is a link to ${target}, on another filesystem than ${folder}`,
    onNone: () => `${backups} is on another filesystem than ${folder}`,
  });
  const fix = Option.match(linkTo, {
    onSome: (target) =>
      `Put the folder in its place: \`rm ${shellWord(backups)} && mv ${shellWord(target)} ${shellWord(backups)}\``,
    onNone: () =>
      `Unmount what is mounted there, then move what it held into ${backups} on the data directory's filesystem`,
  });
  return yield* new UpdateRefused({
    reason: "backups-elsewhere",
    detail: `${where}. A rollback moves the data directory's files into it, which cannot cross filesystems, so backups must be on the data directory's filesystem. ${fix}, then run this again. Nothing was changed.`,
  });
});

/**
 * The install, read once this holds the update lock of its home: what runs
 * and the snapshots cannot change under it then.
 */
const lockedInstall = Effect.gen(function* () {
  // The home the lock is in comes from the install; it does not change with the release that runs.
  yield* holdUpdate((yield* located).home);
  return yield* located;
});

/**
 * Updates the install to `version`, or the latest stable release. While the
 * service runs bots' work, which stopping it stops, `confirm` is asked first,
 * with how many bots, or none when that cannot be told. When the service runs
 * that release already, the command is only pointed at it.
 */
export const update = Effect.fn("update.update")(function* <R>(options: {
  readonly version: Option.Option<string>;
  readonly confirm: (bots: Option.Option<number>) => Effect.Effect<boolean, never, R>;
  readonly say: (line: string) => Effect.Effect<void, never, R>;
}) {
  const installed = yield* lockedInstall;
  const path = yield* Path.Path;
  yield* checkNoUnfinishedRollback(installed.home);
  const from = installed.release;
  const version = yield* targetVersion(options.version);
  if (version === from.version) {
    if (Option.exists(installed.command, (release) => path.basename(release) === version)) {
      return { _tag: "current", version } satisfies UpdateResult;
    }
    yield* writeLauncher({
      install: installed.install,
      launcher: installed.launcher,
      release: installed.root,
    });
    return { _tag: "repointed", version } satisfies UpdateResult;
  }

  yield* checkBackupsBeside(installed.home);
  yield* roomFor(
    installed.home,
    2 * (yield* snapshotBytes(installed.home)) + HOME_ROOM,
    "Copying the databases and installing the new engine",
  );
  yield* roomFor(installed.install, RELEASE_ROOM, `J3 Bots ${version}`);
  yield* options.say(`Downloading J3 Bots ${version}…`);
  const fetched = yield* fetchRelease({
    install: installed.install,
    version,
    platform: from.platform,
  });
  yield* options.say(
    fetched.alreadyThere
      ? `J3 Bots ${version} is already in ${fetched.root}.`
      : `J3 Bots ${version} is checked and unpacked in ${fetched.root}.`,
  );
  if (!(yield* runRelease(installed, fetched.root, ["engine", "fetch"], "relay"))) {
    return yield* new UpdateRefused({ reason: "engine-fetch", detail: version });
  }
  const to = Option.getOrUndefined(yield* releaseOf(fetched.root));

  if (yield* serviceRunning(installed)) {
    const socket = path.join(installed.home, HOME_ENTRIES.adminSocket);
    const work = yield* (yield* AdminClient).runningWork(socket).pipe(
      Effect.map(Option.map(({ bots }) => bots)),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    if (!Option.contains(work, 0) && !(yield* options.confirm(work))) {
      return { _tag: "declined" } satisfies UpdateResult;
    }
  }

  const fromRelease: SnapshotRelease = { version: from.version, ...engineOf(from) };
  const toRelease: SnapshotRelease = { version, ...(to === undefined ? {} : engineOf(to)) };
  const steps = releaseSteps(installed, {
    old: { version: from.version, root: installed.root },
    new: { version, root: fetched.root },
  });
  yield* options.say(
    installed.service
      ? `Stopping the service, copying the databases, and starting J3 Bots ${version}…`
      : "Copying the databases…",
  );
  const outcome = yield* switchOver<Snapshot, SwitchServices>({
    ...steps,
    service: installed.service,
    snapshot: withHome(
      installed.home,
      takeSnapshot({ home: installed.home, from: fromRelease, to: toRelease }),
    ).pipe(Effect.mapError((cause) => new StepFailed({ step: "snapshot", reason: cause.message }))),
  });
  const pruning =
    outcome._tag === "updated"
      ? yield* prune(installed, fromRelease, toRelease).pipe(
          Effect.as(Option.none<string>()),
          Effect.catch((cause) => Effect.succeedSome(cause.message)),
        )
      : Option.none<string>();
  return {
    _tag: "switched",
    from: from.version,
    to: version,
    service: installed.service,
    outcome,
    pruning,
  } satisfies UpdateResult;
}, Effect.scoped);

const engineOf = (release: Installation.ReleaseManifest) =>
  release.engine === undefined ? {} : { engine: release.engine };

type RollbackResult =
  | { readonly _tag: "declined" }
  | {
      readonly _tag: "rolled-back";
      readonly snapshot: Snapshot;
      readonly service: boolean;
      /** The step that failed, if one did: the rollback stopped there. */
      readonly failed: Option.Option<StepFailed>;
    };

/**
 * Puts back `rollbackSnapshot` and starts the release it was taken from, once
 * `confirm` agrees: what the operator asks for with `--rollback`, which also
 * finishes a rollback that was cut off, from where it got. Before anything
 * changes, the install folder, its `versions/` and that release's folder must
 * be this user's alone to change, as an update checks them, and there must be
 * room for the copies the restore has still to make.
 */
export const rollBack = Effect.fn("update.rollBack")(function* <R>(options: {
  readonly confirm: (snapshot: Snapshot) => Effect.Effect<boolean, never, R>;
}) {
  const installed = yield* lockedInstall;
  const path = yield* Path.Path;
  yield* checkBackupsBeside(installed.home);
  const chosen = yield* rollbackSnapshot(installed.home, installed.release.version);
  if (Option.isNone(chosen)) {
    const newest = (yield* listSnapshots(installed.home))[0];
    if (newest === undefined) {
      return yield* new UpdateRefused({ reason: "no-snapshot", detail: installed.home });
    }
    return yield* new UpdateRefused({
      reason: "snapshot-elsewhere",
      detail: `No snapshot in ${path.dirname(newest.folder)} was taken by an update to J3 Bots ${installed.release.version}, the release that runs, so none is the data to roll back to. The newest, ${newest.folder}, was taken by the update from ${newest.manifest.from.version} to ${newest.manifest.to.version}. Nothing was changed.`,
    });
  }
  const snapshot = chosen.value;
  const { from, to } = snapshot.manifest;
  const versions = path.join(installed.install, VERSIONS);
  const oldRoot = path.join(versions, from.version);
  if (!(yield* isRelease(oldRoot))) {
    return yield* new UpdateRefused({ reason: "release-gone", detail: from.version });
  }
  for (const folder of [installed.install, versions, oldRoot]) yield* checkOwnFolder(folder);
  yield* roomFor(
    installed.home,
    (yield* restoreBytes(installed.home, snapshot)) + HOME_ROOM,
    "Putting the snapshot back",
  );
  yield* serviceRunning(installed);
  if (!(yield* options.confirm(snapshot))) return { _tag: "declined" } satisfies RollbackResult;

  const steps = releaseSteps(installed, {
    old: { version: from.version, root: oldRoot },
    new: { version: to.version, root: installed.root },
  });
  const failed = yield* rollBackOver<Snapshot, SwitchServices>(
    { ...steps, service: installed.service },
    snapshot,
  );
  return {
    _tag: "rolled-back",
    snapshot,
    service: installed.service,
    failed,
  } satisfies RollbackResult;
}, Effect.scoped);
