// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AdminClient } from "../admin/AdminClient.ts";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import * as Installation from "../installation.ts";
import { isWithin, realLocation } from "../paths.ts";
import { socketOwner } from "../service/owner.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import {
  installedVersions,
  installFolder,
  recordedLauncher,
  startsInstall,
  VERSIONS,
  writeLauncher,
} from "./layout.ts";
import { fetchRelease, isRelease, targetVersion } from "./release.ts";
import {
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  type Snapshot,
  type SnapshotRelease,
  snapshotBytes,
  takeSnapshot,
} from "./snapshot.ts";
import { type Side, StepFailed, switchOver, type SwitchOutcome } from "./switch.ts";

// `j3-bots update` and `j3-bots update --rollback`, run by the release that is
// installed, which can always start itself again
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md). An
// update prepares without changing anything (the release downloaded and
// checked into `versions/`, its engine fetched), then switches (`switch.ts`),
// then keeps two of everything: releases, snapshots and engine runtimes.

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
        return `J3 Bots ${this.detail}, the release the newest snapshot was taken from, is no longer in this install. Install it with install.sh --version ${this.detail} after \`j3-bots uninstall\`, or put the snapshot back by hand.`;
    }
  }
}

/** The install this copy of J3 Bots runs from, and what it runs with. */
interface Installed {
  readonly install: string;
  /** The j3-bots command it recorded. */
  readonly launcher: string;
  readonly release: Installation.ReleaseManifest;
  /** The folder of the release that runs, in `versions/`. */
  readonly root: string;
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
  return {
    install: install.value,
    launcher: launcher.value,
    release: layout.manifest,
    root: layout.root,
    home,
    service: own,
    environment: {
      ...Object.fromEntries(ServerConfig.SHELL_OVERRIDES.map((name) => [name, undefined])),
      J3_HOME: home,
      PATH: environment.get("PATH") ?? host.searchPath,
    },
  } satisfies Installed;
});

/** Runs the j3-bots of the release at `root` with `args`, its output the operator's: whether it succeeded. */
const runRelease = Effect.fn("update.runRelease")(function* (
  installed: Installed,
  root: string,
  args: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exit = yield* spawner
    .exitCode(
      ChildProcess.make(path.join(root, "bin", "j3-bots"), [...args], {
        env: installed.environment,
        extendEnv: true,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.orElseSucceed(() => -1));
  return exit === 0;
});

/**
 * Fails unless no server outside the service runs for the home: the files
 * are copied and put back with no server on them.
 */
const checkNoOutsideServer = Effect.fn("update.checkNoOutsideServer")(function* (
  installed: Installed,
) {
  const path = yield* Path.Path;
  const { owner } = yield* socketOwner(path.join(installed.home, HOME_ENTRIES.adminSocket));
  if (owner === "nobody" || (owner === "service" && installed.service)) return owner;
  return yield* new UpdateRefused({ reason: "server-outside", detail: installed.home });
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
  start: (side: Side) =>
    runRelease(installed, releases[side].root, ["service", "install"]).pipe(
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
  restore: (snapshot: Snapshot) =>
    restoreSnapshot(installed.home, snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "restore", reason: cause.message })),
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

/**
 * Updates the install to `version`, or the latest stable release. While the
 * service runs bots' work, which stopping it stops, `confirm` is asked first,
 * with how many bots, or none when that cannot be told.
 */
export const update = Effect.fn("update.update")(function* <R>(options: {
  readonly version: Option.Option<string>;
  readonly confirm: (bots: Option.Option<number>) => Effect.Effect<boolean, never, R>;
  readonly say: (line: string) => Effect.Effect<void, never, R>;
}) {
  const installed = yield* located;
  const path = yield* Path.Path;
  const from = installed.release;
  const version = yield* targetVersion(options.version);
  if (version === from.version) return { _tag: "current", version } satisfies UpdateResult;

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
  if (!(yield* runRelease(installed, fetched.root, ["engine", "fetch"]))) {
    return yield* new UpdateRefused({ reason: "engine-fetch", detail: version });
  }
  const to = Option.getOrUndefined(yield* releaseOf(fetched.root));

  if ((yield* checkNoOutsideServer(installed)) === "service") {
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
    service: installed.service,
    stop: steps.stop,
    snapshot: takeSnapshot({ home: installed.home, from: fromRelease, to: toRelease }).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "snapshot", reason: cause.message })),
    ),
    start: steps.start,
    ready: steps.ready,
    restore: steps.restore,
    pointCommand: steps.pointCommand("new"),
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
});

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
 * Puts back the newest snapshot and starts the release it was taken from,
 * once `confirm` agrees: what the operator asks for with `--rollback`. Only a
 * snapshot taken by the update to the release that runs now.
 */
export const rollBack = Effect.fn("update.rollBack")(function* <R>(options: {
  readonly confirm: (snapshot: Snapshot) => Effect.Effect<boolean, never, R>;
}) {
  const installed = yield* located;
  const path = yield* Path.Path;
  const newest = (yield* listSnapshots(installed.home))[0];
  if (newest === undefined) {
    return yield* new UpdateRefused({ reason: "no-snapshot", detail: installed.home });
  }
  const { from, to } = newest.manifest;
  if (to.version !== installed.release.version) {
    return yield* new UpdateRefused({
      reason: "snapshot-elsewhere",
      detail: `The newest snapshot, ${newest.folder}, was taken by the update from J3 Bots ${from.version} to ${to.version}, but ${installed.release.version} is installed, so it is not the data to roll back to. Nothing was changed.`,
    });
  }
  const oldRoot = path.join(installed.install, VERSIONS, from.version);
  if (!(yield* isRelease(oldRoot))) {
    return yield* new UpdateRefused({ reason: "release-gone", detail: from.version });
  }
  yield* checkNoOutsideServer(installed);
  if (!(yield* options.confirm(newest))) return { _tag: "declined" } satisfies RollbackResult;

  const steps = releaseSteps(installed, {
    old: { version: from.version, root: oldRoot },
    new: { version: to.version, root: path.join(installed.install, VERSIONS, to.version) },
  });
  const failed = yield* Effect.gen(function* () {
    if (installed.service) yield* steps.stop;
    yield* steps.restore(newest);
    if (installed.service) {
      yield* steps.start("old");
      yield* steps.ready("old");
    }
    yield* steps.pointCommand("old");
  }).pipe(
    Effect.as(Option.none<StepFailed>()),
    Effect.catch((step) => Effect.succeedSome(step)),
    Effect.uninterruptible,
  );
  return {
    _tag: "rolled-back",
    snapshot: newest,
    service: installed.service,
    failed,
  } satisfies RollbackResult;
});
