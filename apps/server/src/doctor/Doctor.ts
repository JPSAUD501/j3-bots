// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EngineInstallFailure,
  EngineStatus,
  ProviderStatus,
  UnavailableReason,
} from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import rootPackage from "../../../../package.json" with { type: "json" };
import { AdminClient } from "../admin/AdminClient.ts";
import type { AdminStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { findHarness, type Harness, type HarnessFacts, HARNESSES } from "../engine/harnesses.ts";
import { PROVIDER_HOMES } from "../home/entries.ts";
import * as Home from "../home/Home.ts";
import {
  installFolder,
  launchedRelease,
  recordedLauncher,
  startedRelease,
  startsInstall,
} from "../install/layout.ts";
import {
  listSnapshots,
  type RestoreState,
  heldOff,
  rollbackSnapshot,
  type Snapshot,
  takenAt,
  unfinishedRollback,
} from "../install/snapshot.ts";
import * as Installation from "../installation.ts";
import { socketOwner } from "../service/owner.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { type PortUse, portAdvice } from "../system/Ports.ts";
import { lingerAdvice, Systemd } from "../system/Systemd.ts";
import { isBuilt } from "../web/built.ts";
import { type Check, check } from "./check.ts";
import {
  engineDownloadCheck,
  missingHarnessCheck,
  noWayToModels,
  runningUserCheck,
  userManagerCheck,
} from "./newInstall.ts";

// `j3-bots doctor`: everything the server needs from this machine, checked
// one by one, each answer a plain sentence and, when something is wrong, the
// fix. It reads and asks; it changes nothing and never starts the engine.

export type { Check, CheckStatus } from "./check.ts";

const GIB = 1024 ** 3;
/** Below this the engine's download, the database and the bots' work may not fit. */
const DISK_PROBLEM_BYTES = 1 * GIB;
const DISK_WARNING_BYTES = 3 * GIB;

/** The Node release J3 Bots is built and tested with; any release of its major runs it. */
const TESTED_NODE = rootPackage.engines.node;
const majorOf = (version: string) => version.split(".")[0] ?? "";

const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

const nodeCheck = (version: string) =>
  majorOf(version) === majorOf(TESTED_NODE)
    ? check(
        "Node",
        "ok",
        version === TESTED_NODE
          ? `Node ${version}.`
          : `Node ${version}. J3 Bots is tested on ${TESTED_NODE}.`,
      )
    : check(
        "Node",
        "problem",
        `This is Node ${version}; J3 Bots needs Node ${majorOf(TESTED_NODE)}.`,
        `Install Node ${TESTED_NODE} and run this again with it.`,
      );

/** What the server waits for, by why the home is not private. */
const HOME_UNTIL: Record<Home.HomeNotPrivate["reason"], string> = {
  "not-a-folder": "it is a folder",
  "not-owned": "this user owns it",
  "open-to-others": "only this user can",
  "closed-to-owner": "they do",
  unverifiable: "it can check that only this user can",
  unreadable: "it can check that only this user can open it",
};

const homeCheck = Effect.fn("doctor.home")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  // First, so a home the system will not show is reported as one, with its fix.
  const privacy = yield* Home.checkPrivateHome(home).pipe(Effect.result);
  if (privacy._tag === "Failure") {
    const { reason, summary, fix } = privacy.failure;
    return check(
      "Data directory",
      "problem",
      `${summary} The server refuses to start until ${HOME_UNTIL[reason]}.`,
      fix,
    );
  }
  const present = yield* fs.exists(home).pipe(Effect.result);
  if (present._tag === "Failure") {
    // Not a missing home: the server would fail on it too, as when a disk reports errors.
    const { cause, message } = present.failure;
    return check(
      "Data directory",
      "problem",
      `The file system could not say whether ${home} exists: ${Predicate.isError(cause) ? cause.message : message} The server refuses to start until it can.`,
    );
  }
  if (!present.success) {
    return check(
      "Data directory",
      "ok",
      `${home} does not exist yet; the server creates it on its first start.`,
    );
  }
  const writability = yield* Home.checkWritable(home).pipe(Effect.result);
  if (writability._tag === "Failure") {
    const { summary, fix } = writability.failure;
    return check(
      "Data directory",
      "problem",
      `${summary} The server refuses to start until it can write there.`,
      fix,
    );
  }
  return check("Data directory", "ok", `${home}, open to this user only.`);
});

const diskCheck = Effect.fn("doctor.disk")(function* (home: string) {
  const host = yield* Host;
  const free = yield* host.freeSpace(home);
  if (Option.isNone(free)) {
    return check("Disk space", "warning", `Could not read the free space where ${home} is.`);
  }
  const amount = formatBytes(free.value);
  if (free.value < DISK_PROBLEM_BYTES) {
    return check(
      "Disk space",
      "problem",
      `Only ${amount} free where ${home} is. The engine alone needs about 1 GB.`,
      "Free some space on that disk, or move J3_HOME to a larger one.",
    );
  }
  if (free.value < DISK_WARNING_BYTES) {
    return check(
      "Disk space",
      "warning",
      `${amount} free where ${home} is. Bots' work and logs will need more over time.`,
      "Free some space on that disk.",
    );
  }
  return check("Disk space", "ok", `${amount} free where ${home} is.`);
});

/**
 * The release the installed service starts, by version, when install.sh
 * installed it, and the one the j3-bots command runs, if it can tell.
 */
const installedReleases = Effect.fn("doctor.installedReleases")(function* (
  installation: Installation.Installation,
  unitText: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const install = yield* installFolder(installation);
  if (Option.isNone(install)) return Option.none();
  const launcher = yield* recordedLauncher(install.value);
  const command = Option.isSome(launcher)
    ? Option.map(yield* launchedRelease(launcher.value), (release) => path.basename(release))
    : Option.none<string>();
  const execStart = Option.map(unitText, Unit.execStartOf);
  const service =
    Option.isSome(execStart) && (yield* startsInstall(execStart.value, install.value))
      ? Option.map(yield* startedRelease(execStart.value, install.value), (release) =>
          path.basename(release),
        )
      : Option.none<string>();
  return Option.some({ service, command });
});

/** The release the service runs and the one the j3-bots command runs, as far as each is known. */
interface Releases {
  readonly service: Option.Option<string>;
  readonly command: Option.Option<string>;
}

/**
 * Whether the j3-bots command runs the release the service runs. An update or
 * a rollback cut off after the unit was written, and before the command was
 * pointed, leaves them apart.
 */
const commandCheck = (releases: Releases) => {
  if (Option.isNone(releases.service)) return Option.none<Check>();
  const service = releases.service.value;
  return Option.some(
    Option.contains(releases.command, service)
      ? check("Command", "ok", `j3-bots runs J3 Bots ${service}, as the service does.`)
      : check(
          "Command",
          "warning",
          Option.match(releases.command, {
            onSome: (command) =>
              `The service runs J3 Bots ${service}, but the j3-bots command runs ${command}: an update or a rollback stopped before it pointed the command.`,
            onNone: () =>
              `The service runs J3 Bots ${service}, but the j3-bots command is not one install.sh or an update wrote.`,
          }),
          `Run \`j3-bots update --version ${service}\`, which points the command at the release the service runs.`,
        ),
  );
};

/** A rollback that has not finished, with its mark. */
type Rollback = Option.Option<{ readonly snapshot: Snapshot; readonly mark: RestoreState }>;

/**
 * A check while a rollback has not finished: as it is when all is well, as
 * when the server the rollback started runs. Otherwise it still says what it
 * found, but waits for the rollback instead of giving its own fix, which a
 * refused server start would defeat: the Snapshot check says what to do.
 */
const whileRollingBack = (rollback: Rollback, found: Check) =>
  Option.isSome(rollback) && found.status !== "ok"
    ? check(
        found.name,
        "skipped",
        `${found.summary} Waits for the rollback to finish: see Snapshot.`,
      )
    : found;

/** What the mark of a rollback that has not finished says it put back, as a clause. */
const progressOf = (mark: RestoreState) => {
  switch (mark.stage) {
    case "copying":
      return ", and has put none of it back";
    case "unread":
      return ", and its mark, which says how far it got, cannot be read";
    case "swapping":
    case "restored":
      return "";
  }
};

/**
 * The snapshot `j3-bots update --rollback` puts back while `running` runs,
 * and a rollback that has not finished, which is then the one thing to do.
 */
const snapshotCheck = Effect.fn("doctor.snapshot")(function* (
  home: string,
  running: Option.Option<string>,
  rollback: Rollback,
  releases: Option.Option<Releases>,
) {
  if (Option.isSome(rollback)) {
    const { snapshot, mark } = rollback.value;
    return check(
      "Snapshot",
      "problem",
      `A rollback to J3 Bots ${mark.release}, from ${snapshot.folder}, has not finished${progressOf(mark)}. Until it does, ${heldOff(mark.release, mark.stage === "restored")}.`,
      mark.stage === "copying"
        ? `Run \`j3-bots update --rollback\`, which finishes it. If it fails every time, as when a file of the snapshot is lost, \`j3-bots update --rollback --abandon\` gives it up and starts J3 Bots ${snapshot.manifest.to.version} again on the data as it is.`
        : "Run `j3-bots update --rollback`, which finishes it.",
    );
  }
  // As `--rollback` refuses then: the snapshot it would find is an older update's.
  const apart = Option.exists(
    releases,
    ({ service, command }) =>
      Option.isSome(service) && Option.isSome(command) && command.value !== service.value,
  );
  if (apart) {
    return check(
      "Snapshot",
      "skipped",
      "`j3-bots update --rollback` puts nothing back while the j3-bots command runs another release than the service. Waits for the command: see Command.",
    );
  }
  const snapshots = yield* listSnapshots(home);
  const chosen = Option.isSome(running)
    ? yield* rollbackSnapshot(home, running.value)
    : Option.fromNullishOr(snapshots[0]);
  if (Option.isNone(chosen)) {
    return check(
      "Snapshot",
      "ok",
      snapshots.length === 0
        ? "None yet: `j3-bots update` copies the databases before it changes release."
        : `None to roll back to: no snapshot was taken by an update to J3 Bots ${Option.getOrElse(running, () => "")}.`,
    );
  }
  const { from, to } = chosen.value.manifest;
  return check(
    "Snapshot",
    "ok",
    `${chosen.value.folder}, taken at ${takenAt(chosen.value)} by the update from J3 Bots ${from.version} to ${to.version}: what \`j3-bots update --rollback\` puts back.`,
  );
});

/** `http://192.168.1.20:3737`, `https://[fd7a::1]:3737`: where a listener is, for reading. */
const listenerAddress = (listener: AdminStatus["listener"]) =>
  `${listener.scheme}://${NetAddress.formatUrlHostString(listener.address)}:${listener.port}`;

/** The running server's ports, as it bound them and as its engine reports. */
const runningPortsCheck = (status: AdminStatus) => {
  const { engine, enginePort, toolPort } = status;
  if (engine.state._tag === "unavailable" && engine.state.reason === "port-in-use") {
    return check(
      "Ports",
      "problem",
      `Port ${enginePort}, for the engine, is held by another program, so the engine cannot start.`,
      `Stop that program (\`ss -ltnp 'sport = :${enginePort}'\` names it), or set "enginePort" in the configuration to a free port and restart the service.`,
    );
  }
  const engineSide =
    engine.state._tag === "ready"
      ? `the engine answers on ${enginePort}`
      : `the engine's port is ${enginePort}`;
  return check(
    "Ports",
    "ok",
    `The running server listens on ${listenerAddress(status.listener)}, the bot tools on ${toolPort}, and ${engineSide}.`,
  );
};

/**
 * The names the running server refused over plain HTTP (`RefusedNames`), when
 * there are any: most often a proxy or tunnel in front of it that passes on a
 * name `publicOrigin` does not give, so every page through it is a 403.
 */
const refusedNamesCheck = (status: AdminStatus, configFile: string) => {
  const names = status.refusedNames ?? [];
  if (names.length === 0) return Option.none();
  const listed = names.join(", ");
  return Option.some(
    check(
      "Refused names",
      "warning",
      `Since it started, the server refused plain-HTTP requests for ${names.length === 1 ? "a name" : "names"} it does not answer: ${listed}.`,
      `If a proxy or tunnel serves J3 Bots at one of these names, set "publicOrigin" in ${configFile} to its https address and restart the server. Otherwise open J3 Bots at localhost or at the address \`j3-bots pair\` prints.`,
    ),
  );
};

/** With no server running, whether each port could be listened on now. */
const freePortsCheck = Effect.fn("doctor.ports")(function* (
  config: ServerConfig.ServerConfigShape,
) {
  const host = yield* Host;
  const wanted: ReadonlyArray<PortUse> = [
    { label: "the server", host: config.host, port: config.port, setting: "port" },
    { label: "the bot tools", host: "127.0.0.1", port: config.toolPort, setting: "toolPort" },
    { label: "the engine", host: "127.0.0.1", port: config.enginePort, setting: "enginePort" },
  ];
  for (const use of wanted) {
    const state = yield* host.portState(use.host, use.port);
    if (state._tag === "free") continue;
    const { summary, fix } = portAdvice(state, use, config.configFile);
    return check("Ports", "problem", summary, fix);
  }
  return check(
    "Ports",
    "ok",
    `${config.port}, ${config.toolPort} and ${config.enginePort} are free.`,
  );
});

const UNAVAILABLE_REASONS: Record<
  Extract<EngineStatus["state"], { _tag: "unavailable" }>["reason"],
  { readonly summary: string; readonly fix: string }
> = {
  down: {
    summary: "The engine is not running; the server keeps restarting it.",
    fix: "Read why in the log: `journalctl --user -u j3-bots -n 100`.",
  },
  "port-in-use": {
    summary: "Another program listens on the engine's port, so the engine cannot start.",
    fix: 'Stop that program, or set "enginePort" in the configuration to a free port and restart the service.',
  },
  "install-failed": {
    summary: "The server could not install the pinned engine; it keeps trying.",
    fix: "Read why in the log: `journalctl --user -u j3-bots -n 100`.",
  },
  "credential-refused": {
    summary: "The engine refused the server's credential.",
    fix: "Restart the service. If it happens again, report it with the log.",
  },
};

/** What mends an engine install that failed for each reason the server gives (`installFailure`). */
const INSTALL_FIXES: Record<EngineInstallFailure, string> = {
  "unsupported-platform": "Run J3 Bots on Linux (x64 or arm64), macOS (arm64) or Windows (x64).",
  download: "Check this machine's internet connection; the server tries again on its own.",
  checksum:
    "The server downloads it again on its own. If it keeps failing, report it with the log.",
  extract: "The server tries again on its own. If it keeps failing, report it with the log.",
  storage:
    "Free some space on the disk that holds the data directory; the server tries again on its own.",
  "in-use":
    "Another program, such as a virus scanner, kept one of its files open. The server tries again on its own; if it keeps failing, let the scanner skip the data directory.",
  permission: "Make the data directory and everything in it owned by the user the service runs as.",
  "outside-home":
    "A link in the data directory leads out of it. Remove the link; the server tries again on its own.",
  files: "Read why in the log: `journalctl --user -u j3-bots -n 100`.",
  unknown: "Read why in the log: `journalctl --user -u j3-bots -n 100`.",
};

const engineCheck = Effect.fn("doctor.engine")(function* (
  config: ServerConfig.ServerConfigShape,
  status: Option.Option<AdminStatus>,
  /** No server answers on the admin socket. */
  noServer: boolean,
) {
  const host = yield* Host;
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(config.engineBinary)) {
    const binary = config.engineBinary.value;
    if (!(yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false)))) {
      return check(
        "Engine",
        "problem",
        `J3_ENGINE_BINARY names ${binary}, which does not exist.`,
        "Fix the path, or unset J3_ENGINE_BINARY to use the pinned engine.",
      );
    }
  } else {
    const install = yield* EngineLive.inspectInstall({
      home: config.engineHome,
      platform: host.platform,
      arch: host.arch,
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    if (install._tag === "unsupported-platform") {
      return check(
        "Engine",
        "problem",
        `T3 Code ${install.version}, the engine J3 Bots is pinned to, has no release for ${host.platform}-${host.arch}.`,
        "Run J3 Bots on Linux (x64 or arm64) or macOS (arm64).",
      );
    }
    if (install._tag === "missing" && Option.isNone(status)) {
      return yield* engineDownloadCheck(install, noServer);
    }
  }
  if (Option.isNone(status)) {
    return check(
      "Engine",
      "ok",
      Option.isSome(config.engineBinary)
        ? `The server will run the engine at ${config.engineBinary.value}.`
        : "The pinned engine is installed.",
    );
  }
  const engine = status.value.engine;
  switch (engine.state._tag) {
    case "ready":
      return check("Engine", "ok", `T3 Code ${engine.pinnedVersion} is running.`);
    case "starting":
      return engine.state.install === undefined
        ? check("Engine", "warning", "The engine is starting.", "Run this again in a minute.")
        : check(
            "Engine",
            "warning",
            `The engine is downloading: ${EngineLive.progressText(engine.state.install)}.`,
            "Run this again once it has downloaded.",
          );
    case "incompatible":
      return check(
        "Engine",
        "problem",
        `The engine running is T3 Code ${engine.state.runningVersion}, but this release of J3 Bots needs ${engine.pinnedVersion}.`,
        Option.isSome(config.engineBinary)
          ? "Point J3_ENGINE_BINARY at a build of the pinned version, or unset it."
          : "Restart the service so it runs the pinned engine.",
      );
    case "unavailable": {
      const reason = UNAVAILABLE_REASONS[engine.state.reason];
      const { installFailure } = engine.state;
      return check(
        "Engine",
        "problem",
        reason.summary,
        installFailure === undefined ? reason.fix : INSTALL_FIXES[installFailure],
      );
    }
  }
});

/** What a blocked sandbox reads as, by why it is blocked. */
const SANDBOX_BLOCKS = {
  "no-profile": "AppArmor blocks the sandbox it runs in",
  "profile-unloaded":
    "AppArmor blocked the sandbox it runs in when the server last started it, though the profile that allows it is on disk: the system has not loaded that profile",
  unknown:
    "the server could not start the sandbox it runs in when it last tried, for a cause this check does not know",
} as const;

/**
 * What the server's own browser needs from this Linux host: a sandbox
 * AppArmor allows, the libraries it loads, and fonts. A warning, not a
 * problem: a bot's tabs open on the server only while no J3 Bots app is
 * open on a computer, and only for a bot given the browser
 * (docs/operations/operating.md#the-browser). A running server that says the
 * sandbox is blocked may know it from the browser's start, which the files
 * here cannot show without root. `None` off Linux, where it needs nothing.
 */
const browserCheck = Effect.fn("doctor.browser")(function* (
  config: ServerConfig.ServerConfigShape,
  status: Option.Option<AdminStatus>,
) {
  const host = yield* Host;
  if (host.platform !== "linux") return Option.none<Check>();
  const sandboxRefused = Option.exists(
    status,
    ({ engine }) =>
      engine.browser?._tag === "setup-required" && engine.browser.needs.includes("sandbox"),
  );
  const needs = yield* host.browserNeeds({ home: config.home, sandboxRefused });
  const missing = [
    ...(needs.sandbox === "none" ? [] : [SANDBOX_BLOCKS[needs.sandbox]]),
    ...(needs.missingLibraries.length > 0
      ? [`it cannot load ${needs.missingLibraries.join(", ")}`]
      : []),
    ...(needs.noFonts ? ["no font is installed, so pages would show no text"] : []),
  ];
  if (missing.length === 0) {
    return Option.some(
      needs.downloaded
        ? check("Browser", "ok", "The server's browser has what it needs here.")
        : check(
            "Browser",
            "ok",
            "The server's browser may run its sandbox here, and fonts are installed. The server downloads it, about 210 MB, the first time a tab opens on it; run this again then to check its libraries.",
          ),
    );
  }
  const byHand = needs.packagesByHand
    ? [
        `Install ${[
          ...needs.missingLibraries,
          ...(needs.noFonts ? ["fontconfig and a font"] : []),
        ].join(", ")} with this system's package manager.`,
      ]
    : [];
  const commands =
    needs.setup.length > 0
      ? [
          "Have an administrator run, once (as root they run only system tools):",
          ...needs.setup.map((command) => `  ${command}`),
        ]
      : [];
  const sandboxLater =
    needs.sandbox === "none" || needs.sandbox === "no-profile"
      ? []
      : [
          ...(needs.sandbox === "unknown"
            ? [`The server's account of it is in ${SERVICE_LOG}.`]
            : []),
          "The server checks the sandbox again each time its browser starts.",
        ];
  return Option.some(
    check(
      "Browser",
      "warning",
      `The server's browser cannot run, so bots browse only while a J3 Bots app is open on a computer: ${missing.join("; ")}.`,
      [...commands, ...byHand, ...sandboxLater].join("\n"),
    ),
  );
});

/** A scripted agent set: it answers bots' turns instead of a model. */
const scriptedAgentCheck = (config: ServerConfig.ServerConfigShape) =>
  Option.map(config.scriptedAgent, (agent) =>
    check(
      "Scripted agent",
      "warning",
      `A scripted agent answers instead of a real model: ${agent} is offered to bots first, so new bots run on it. It is for test installs, never for real use.`,
      `Remove scriptedAgent from ${config.configFile}, or unset J3_SCRIPTED_AGENT, and restart the server.`,
    ),
  );

/** Where the engine's own account of a provider's check is, in the service's log. */
const SERVICE_LOG = "`journalctl --user -u j3-bots -n 100`";

/**
 * A provider the engine is done checking and cannot run, by why
 * (`UnavailableReason`): the harness was found at `path` on the service's
 * `PATH`, which the engine runs with.
 */
const unavailableCheck = (
  harness: HarnessFacts,
  provider: string,
  path: string,
  reason: UnavailableReason | undefined,
  detail: string | undefined,
): Check => {
  // The engine's own words, as it reported them, when it gave any.
  const says = detail === undefined ? "" : ` The engine says: ${detail}`;
  switch (reason) {
    case "not-installed":
      return check(
        harness.name,
        "problem",
        `\`${harness.executable}\` is at ${path}, but the engine did not find it, so it cannot run ${provider}.${says}`,
        `Restart the service so the engine starts again with its PATH: \`systemctl --user restart j3-bots\`. If it still does not find it, the log says where it looked: ${SERVICE_LOG}.`,
      );
    case "failed":
      return check(
        harness.name,
        "problem",
        `The engine found ${harness.name} at ${path}, but its check of ${provider} failed, so no bot runs on it.${says}`,
        `Run \`${harness.executable} --version\` as this user to see whether it starts; the log has the engine's own account: ${SERVICE_LOG}. Once it starts, restart the service: \`systemctl --user restart j3-bots\`.`,
      );
    case "disabled":
      return check(
        harness.name,
        "problem",
        `${provider} is turned off: the server could not safely set up ${harness.name}'s configuration, so it left it off.`,
        `The log names the file it could not read or edit: ${SERVICE_LOG}. Repair or remove that file, then restart the service: \`systemctl --user restart j3-bots\`.`,
      );
    case "unknown":
    case undefined:
      return check(
        harness.name,
        "problem",
        `The engine cannot run ${provider}.`,
        `Read why in the log: ${SERVICE_LOG}.`,
      );
  }
};

/**
 * A provider whose last check timed out, which the server checks again on
 * its own (`retryAt`): what a busy machine causes, as just after an update,
 * so a warning until its checks keep timing out.
 */
const recheckingCheck = Effect.fn("doctor.recheckingProvider")(function* (
  harness: HarnessFacts,
  provider: string,
  path: string,
  retryAt: DateTime.Utc,
  detail: string | undefined,
) {
  const seconds = Math.ceil(
    (DateTime.toEpochMillis(retryAt) - DateTime.toEpochMillis(yield* DateTime.now)) / 1000,
  );
  const when = seconds > 0 ? `in ${seconds} s` : "now";
  const says = detail === undefined ? "" : ` The engine says: ${detail}`;
  return check(
    harness.name,
    "warning",
    `The engine found ${harness.name} at ${path}, but its check of ${provider} did not end in time, as on a machine busy starting. The server checks it again on its own ${when}.${says}`,
    `Run this again in a minute. If its checks keep timing out, run \`${harness.executable} --version\` as this user to see whether it starts; the log has the engine's own account: ${SERVICE_LOG}.`,
  );
});

const providerCheck = Effect.fn("doctor.provider")(function* (
  id: Harness,
  status: Option.Option<AdminStatus>,
  /** The Engine line, whose fix is the one to follow while the engine is not ready. */
  engineLine: Check,
  where: {
    readonly servicePath: Option.Option<string>;
    readonly serviceHome: Option.Option<string>;
    /** The server's home, where J3 Bots' own copy of the harness is, when it installed one. */
    readonly home: string;
  },
) {
  const { servicePath, serviceHome } = where;
  const harness = HARNESSES[id];
  const found = (yield* findHarness(id, servicePath, where.home)).executable;
  if (Option.isNone(found)) return yield* missingHarnessCheck(id, servicePath, serviceHome);
  if (Option.isNone(status)) {
    return check(
      harness.name,
      "ok",
      `Found at ${found.value}. Start the server to see what the engine reports about it.`,
    );
  }
  // Only a ready engine reports its providers: until then the server reports
  // none, which says nothing about the harness or the providers set up.
  if (status.value.engine.state._tag !== "ready") {
    return {
      name: harness.name,
      status: "warning",
      summary: `Found at ${found.value}; it cannot be checked until the engine is ready.`,
      fix: engineLine.fix,
    } satisfies Check;
  }
  const providers = status.value.engine.providers.filter(
    (provider: ProviderStatus) => provider.harness === id,
  );
  if (providers.length === 0) {
    return check(
      harness.name,
      "warning",
      `Found at ${found.value}, but the server has no ${harness.name} provider set up, so no bot runs on it.`,
      "Update the server: a release that runs bots sets up a Claude Code and a Codex provider.",
    );
  }
  // While the engine's first check since it started is under way, what it
  // reports says nothing of the harness, so no other line is drawn from it. A
  // check that never ends stops counting as under way after a minute and a
  // half (`FIRST_CHECK_BUDGET` in the engine adapter), and is then a problem.
  const unchecked = providers.find(
    (provider) => provider.status._tag === "unavailable" && provider.status.checking,
  );
  if (unchecked !== undefined) {
    return check(
      harness.name,
      "warning",
      `Found at ${found.value}; the engine is still checking ${unchecked.name}, which can take up to a minute after it starts.`,
      "Run this again in half a minute.",
    );
  }
  for (const provider of providers) {
    if (provider.status._tag === "sign-in-required") {
      return noWayToModels(id, provider.status.command);
    }
  }
  for (const provider of providers) {
    if (provider.status._tag === "unavailable") {
      const { reason, detail, retryAt } = provider.status;
      return retryAt === undefined
        ? unavailableCheck(harness, provider.name, found.value, reason, detail)
        : yield* recheckingCheck(harness, provider.name, found.value, retryAt, detail);
    }
  }
  const limited = providers.find((provider) => provider.status._tag === "limited");
  if (limited !== undefined) {
    return check(
      harness.name,
      "warning",
      `${limited.name} has reached its usage limit; its bots wait until it resets.`,
      "Wait for the reset, or move the bots that cannot wait to another provider.",
    );
  }
  return check(harness.name, "ok", `Found at ${found.value}; the engine reports it ready.`);
});

/** Whether the web client is served: as the server reports it while one runs, else as it is on disk. */
const webClientCheck = Effect.fn("doctor.webClient")(function* (
  config: ServerConfig.ServerConfigShape,
  live: LiveServer,
  installation: Installation.Installation,
) {
  const directory = config.webClient.directory;
  if (live._tag === "described" && live.status.webClient === "served") {
    return check("Web client", "ok", "The running server serves it.");
  }
  if (!(yield* isBuilt(directory))) {
    const fromRelease =
      config.webClient._tag === "bundled" && installation.layout._tag === "release";
    return check(
      "Web client",
      "warning",
      `No web client is built in ${directory}, so the server serves only its API.`,
      fromRelease
        ? "The release is incomplete: unpack it again, then restart the service: `systemctl --user restart j3-bots`."
        : "Run `pnpm build` in this checkout, then restart the service: `systemctl --user restart j3-bots`.",
    );
  }
  switch (live._tag) {
    case "described":
      return check(
        "Web client",
        "warning",
        `It was built in ${directory} after the server started, so it is not served yet.`,
        "Restart the service: `systemctl --user restart j3-bots`.",
      );
    case "garbled":
      return check(
        "Web client",
        "ok",
        `Built in ${directory}. The server on the admin socket does not say whether it serves it.`,
      );
    case "outside":
      return check(
        "Web client",
        "ok",
        `Built in ${directory}. The service is not running, so it does not serve it yet.`,
      );
    case "none":
    case "blocked":
      return check(
        "Web client",
        "ok",
        `Built in ${directory}. The server is not running, so it does not serve it yet.`,
      );
  }
});

const pairingCheck = (status: Option.Option<AdminStatus>, outside: boolean) => {
  if (Option.isNone(status)) {
    return check(
      "Pairing",
      "skipped",
      outside
        ? "Start the service, once the server outside it stops, to see which devices are paired."
        : "Start the server to see which devices are paired.",
    );
  }
  const count = status.value.pairedDevices;
  return count === 0
    ? check(
        "Pairing",
        "warning",
        "No device is paired yet.",
        "Run `j3-bots pair`, then open J3 Bots on the new device and enter the code.",
      )
    : check(
        "Pairing",
        "ok",
        count === 1 ? "One device is paired." : `${count} devices are paired.`,
      );
};

const serviceChecks = Effect.fn("doctor.service")(function* (
  unitText: Option.Option<string>,
  rollback: Rollback,
) {
  const host = yield* Host;
  if (host.platform !== "linux") {
    return [
      check(
        "Service",
        "skipped",
        "The service runs under systemd, on Linux. Here, run `j3-bots serve` yourself.",
      ),
    ];
  }
  const systemd = yield* Systemd;
  const manager = yield* userManagerCheck(Option.isSome(unitText));
  if (manager.status !== "ok") {
    return [manager, check("Service", "skipped", "It needs this user's systemd manager.")];
  }
  const checks: Array<Check> = [manager];
  if (Option.isNone(unitText)) {
    checks.push(
      whileRollingBack(
        rollback,
        check(
          "Service",
          "warning",
          "The service is not installed, so the server does not start on its own.",
          "Run `j3-bots service install`.",
        ),
      ),
    );
  } else {
    const unit = yield* systemd.unitState(Unit.UNIT_NAME);
    checks.push(
      whileRollingBack(
        rollback,
        // The unit restarts on failure, so one that stays `failed` is one systemd
        // stopped restarting: it hit the start limit, and systemd refuses a
        // restart within the limit's interval unless that is reset.
        unit.active === "failed"
          ? check(
              "Service",
              "problem",
              "The service has failed, and systemd has stopped restarting it.",
              "Read why with `journalctl --user -u j3-bots -n 100`. Once the cause is fixed, clear systemd's start limit with `systemctl --user reset-failed j3-bots`, then run `systemctl --user restart j3-bots`.",
            )
          : unit.active === "activating"
            ? check(
                "Service",
                "warning",
                "The service is starting or restarting.",
                "Read the log: `journalctl --user -u j3-bots -n 100`.",
              )
            : unit.active !== "active"
              ? check(
                  "Service",
                  "warning",
                  `The service is installed but ${unit.active}.`,
                  "Start it with `systemctl --user start j3-bots`.",
                )
              : !unit.enabled
                ? check(
                    "Service",
                    "warning",
                    "The service runs but is not enabled, so it will not start again after a reboot.",
                    "Run `systemctl --user enable j3-bots`.",
                  )
                : check("Service", "ok", "Installed, enabled and running."),
      ),
    );
  }

  const linger = yield* systemd.linger;
  if (linger === "yes") {
    checks.push(
      check("Start at boot", "ok", "Lingering is on: the service runs without a login session."),
    );
  } else {
    const { summary, fix } = lingerAdvice(linger);
    checks.push(check("Start at boot", "warning", summary, fix));
  }

  checks.push(
    (yield* systemd.memoryControllerDelegated)
      ? check("Memory limit", "ok", "The service's memory limit applies.")
      : check(
          "Memory limit",
          "warning",
          "The kernel does not let the user manager limit memory, so the service's MemoryHigh has no effect.",
          "On a Raspberry Pi, add `cgroup_enable=memory` to /boot/firmware/cmdline.txt and reboot.",
        ),
  );
  return checks;
});

/**
 * With the service installed, the overrides set in this shell: the service
 * does not get them, and one the server would refuse is named on its own.
 */
const overridesCheck = Effect.fn("doctor.overrides")(function* (configFile: string) {
  const overrides = yield* ServerConfig.shellOverrides;
  if (overrides.length === 0) return Option.none<Check>();
  const notes = overrides.map((name) => ServerConfig.overrideNote(name, configFile)).join(" ");
  const invalid = yield* ServerConfig.invalidShellOverrides;
  if (invalid.length > 0) {
    return Option.some(
      check(
        "Shell settings",
        "problem",
        `${invalid.join(", ")} ${invalid.length === 1 ? "has a value" : "have values"} the server refuses, so \`j3-bots serve\` would not start in this shell. The service does not get ${invalid.length === 1 ? "it" : "them"}, so this report describes it as installed.`,
        `Fix or unset ${invalid.join(" and ")} in this shell. ${notes}`,
      ),
    );
  }
  return Option.some(
    check(
      "Shell settings",
      "warning",
      `${overrides.join(", ")} ${overrides.length === 1 ? "is" : "are"} set in this shell, but the service does not get ${overrides.length === 1 ? "it" : "them"}. This report describes the service, which runs with ${configFile}.`,
      notes,
    ),
  );
});

/**
 * The server answering on the admin socket, as the report may describe it:
 * `described` when it is the one the report is about (the service's own main
 * process, with the service installed; any, without), `outside` when the
 * service is installed but another process holds the home, `garbled` when a
 * server answers in other words than this release's, and `none`.
 */
type LiveServer =
  | { readonly _tag: "none" }
  /** Something that is not a socket is where the admin socket goes: no server can start. */
  | { readonly _tag: "blocked"; readonly summary: string; readonly fix: string }
  | { readonly _tag: "described"; readonly status: AdminStatus }
  | { readonly _tag: "outside"; readonly status: Option.Option<AdminStatus> }
  | { readonly _tag: "garbled" };

const NO_SERVER: LiveServer = { _tag: "none" };
const GARBLED: LiveServer = { _tag: "garbled" };

const liveServer = Effect.fn("doctor.liveServer")(function* (
  socket: string,
  serviceInstalled: boolean,
) {
  const path = yield* Home.checkSocketPath(socket).pipe(Effect.result);
  if (path._tag === "Failure") {
    const { summary, fix } = path.failure;
    return { _tag: "blocked", summary, fix } satisfies LiveServer;
  }
  if (serviceInstalled) {
    const { owner, status } = yield* socketOwner(socket);
    switch (owner) {
      case "nobody":
        return NO_SERVER;
      case "service":
        return Option.match(status, {
          onNone: () => GARBLED,
          onSome: (answered): LiveServer => ({ _tag: "described", status: answered }),
        });
      case "other":
        return { _tag: "outside", status } satisfies LiveServer;
      case "unknown":
        return GARBLED;
    }
  }
  const admin = yield* AdminClient;
  const answer = yield* admin.status(socket).pipe(Effect.result);
  if (answer._tag === "Failure") return GARBLED;
  return Option.match(answer.success, {
    onNone: () => NO_SERVER,
    onSome: (answered): LiveServer => ({ _tag: "described", status: answered }),
  });
});

const serverCheck = (live: LiveServer) => {
  switch (live._tag) {
    case "blocked":
      return check("Server", "problem", `${live.summary} The server cannot start.`, live.fix);
    case "garbled":
      return check(
        "Server",
        "problem",
        "A server answers on the admin socket, but not as expected.",
        "Restart it: `systemctl --user restart j3-bots`.",
      );
    case "described":
      return check(
        "Server",
        "ok",
        `J3 Bots ${live.status.version} is running at ${listenerAddress(live.status.listener)}.`,
      );
    case "outside":
      return check(
        "Server",
        "warning",
        Option.match(live.status, {
          onNone: () => "A server outside the service holds this home, so the service cannot run.",
          onSome: ({ version, pid, listener }) =>
            `J3 Bots ${version} is running at ${listenerAddress(listener)} outside the service (process ${pid}), so the service cannot run. This report describes the service, not that server.`,
        }),
        "If you started it yourself on purpose, nothing is wrong. Otherwise stop it, then run `systemctl --user restart j3-bots`.",
      );
    case "none":
      return check(
        "Server",
        "warning",
        "The server is not running.",
        "Start it with `systemctl --user start j3-bots`, or `j3-bots serve` in a terminal.",
      );
  }
};

/**
 * Every check, in the order the report shows them. A damaged release fails
 * the report as a whole: it is the one thing to fix, and nothing it would
 * check runs from it.
 */
export const diagnose = Effect.gen(function* () {
  const installation = yield* Installation.installation;
  const host = yield* Host;
  const checks: Array<Check> = [nodeCheck(host.nodeVersion), yield* runningUserCheck];

  const unitText = yield* Unit.installedUnit;
  const described = yield* Unit.describedConfiguration(unitText);
  const shellSettings = Option.isSome(unitText)
    ? yield* overridesCheck(yield* ServerConfig.resolveConfigFile.pipe(Effect.provide(described)))
    : Option.none<Check>();
  // The running server is found from the home alone and asked whatever the
  // configuration says now: a setting that would refuse the next start does
  // not stop the server that is running.
  const live = yield* liveServer(
    yield* ServerConfig.resolveAdminSocket.pipe(Effect.provide(described)),
    Option.isSome(unitText),
  );
  const releases = yield* installedReleases(installation, unitText);
  const running = Option.orElse(
    Option.flatMap(releases, ({ service }) => service),
    () =>
      installation.layout._tag === "release"
        ? Option.some(installation.layout.manifest.version)
        : Option.none(),
  );
  const loaded = yield* ServerConfig.load.pipe(Effect.provide(described), Effect.result);
  if (loaded._tag === "Failure") {
    checks.push(
      check(
        "Configuration",
        "problem",
        loaded.failure.message,
        "Fix the setting it names, then run this again.",
      ),
    );
    const home = yield* ServerConfig.resolveHome.pipe(Effect.provide(described));
    const rollback = yield* unfinishedRollback(home);
    checks.push(yield* homeCheck(home));
    checks.push(yield* snapshotCheck(home, running, rollback, releases));
    checks.push(whileRollingBack(rollback, serverCheck(live)));
    checks.push(...(yield* serviceChecks(unitText, rollback)));
    if (Option.isSome(shellSettings)) checks.push(shellSettings.value);
    return checks;
  }
  const config = loaded.success;
  const fs = yield* FileSystem.FileSystem;
  checks.push(
    (yield* fs.exists(config.configFile).pipe(Effect.orElseSucceed(() => false)))
      ? check("Configuration", "ok", `${config.configFile} is valid.`)
      : check(
          "Configuration",
          "ok",
          `No ${config.configFile} yet; the server writes one with the defaults on its first start.`,
        ),
  );
  checks.push(yield* homeCheck(config.home));
  checks.push(yield* diskCheck(config.home));
  const rollback = yield* unfinishedRollback(config.home);
  checks.push(yield* snapshotCheck(config.home, running, rollback, releases));

  // Only a server the report describes lends it live diagnostics.
  const status = live._tag === "described" ? Option.some(live.status) : Option.none();
  checks.push(whileRollingBack(rollback, serverCheck(live)));
  switch (live._tag) {
    case "described": {
      checks.push(runningPortsCheck(live.status));
      const refused = refusedNamesCheck(live.status, config.configFile);
      if (Option.isSome(refused)) checks.push(refused.value);
      break;
    }
    case "garbled":
      checks.push(
        check("Ports", "skipped", "A server holds the admin socket, so its ports are not checked."),
      );
      break;
    case "outside":
      checks.push(
        check(
          "Ports",
          "skipped",
          "A server outside the service holds this home, so the service's ports are not checked.",
        ),
      );
      break;
    case "none":
    case "blocked":
      checks.push(yield* freePortsCheck(config));
  }
  const engine = yield* engineCheck(config, status, live._tag === "none");
  checks.push(engine);
  const browser = yield* browserCheck(config, status);
  if (Option.isSome(browser)) checks.push(browser.value);
  const scripted = scriptedAgentCheck(config);
  if (Option.isSome(scripted)) checks.push(scripted.value);
  const servicePath = Unit.servicePathOf(unitText);
  for (const harness of PROVIDER_HOMES) {
    checks.push(
      yield* providerCheck(harness, status, engine, {
        servicePath,
        serviceHome: Unit.serviceHomeOf(unitText),
        home: config.home,
      }),
    );
  }
  checks.push(yield* webClientCheck(config, live, installation));
  checks.push(pairingCheck(status, live._tag === "outside"));
  checks.push(...(yield* serviceChecks(unitText, rollback)));
  const command = Option.flatMap(releases, commandCheck);
  if (Option.isSome(command)) {
    checks.push(whileRollingBack(rollback, command.value));
  }
  if (Option.isSome(shellSettings)) checks.push(shellSettings.value);
  return checks;
});
