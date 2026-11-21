// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import rootPackage from "../../../../package.json" with { type: "json" };
import { AdminClient } from "../admin/AdminClient.ts";
import { type AdminStatus, CONNECT_RESTARTS } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import * as Home from "../home/Home.ts";
import * as Installation from "../installation.ts";
import { socketOwner } from "../service/owner.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { type PortUse, portAdvice } from "../system/Ports.ts";
import { lingerAdvice, Systemd } from "../system/Systemd.ts";
import { isBuilt } from "../web/built.ts";

// `j3-bots doctor`: everything the server needs from this machine, checked
// one by one, each answer a plain sentence and, when something is wrong, the
// fix. It reads and asks; it changes nothing and never starts the engine.

export type CheckStatus = "ok" | "warning" | "problem" | "skipped";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly fix: Option.Option<string>;
}

const check = (name: string, status: CheckStatus, summary: string, fix?: string): Check => ({
  name,
  status,
  summary,
  fix: Option.fromNullishOr(fix),
});

const GIB = 1024 ** 3;
/** Below this the engine's download, the database and the bots' work may not fit. */
const DISK_PROBLEM_BYTES = 1 * GIB;
const DISK_WARNING_BYTES = 3 * GIB;

/** The Node release J3 Bots is built and tested with; any release of its major runs it. */
const TESTED_NODE = rootPackage.engines.node;
const majorOf = (version: string) => version.split(".")[0] ?? "";

const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

const HARNESSES = [
  { harness: "claude-code", name: "Claude Code", executable: "claude" },
  { harness: "codex", name: "Codex", executable: "codex" },
] as const;

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

const HOME_SUMMARIES: Record<Home.HomeNotPrivate["reason"], (home: string) => string> = {
  "not-a-folder": (home) => `${home} is not a folder.`,
  "not-owned": (home) =>
    `${home} belongs to another user. The server refuses to start until this user owns it.`,
  "open-to-others": (home) =>
    `Other users on this machine can open ${home}, which holds the database, the engine's credential and the admin socket. The server refuses to start until only this user can.`,
  "closed-to-owner": (home) =>
    `This user's own permissions on ${home} do not let it read, write and open the files there. The server refuses to start until they do.`,
};

const homeCheck = Effect.fn("doctor.home")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
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
  const privacy = yield* Home.checkPrivate(home).pipe(Effect.result);
  if (privacy._tag === "Failure") {
    const { reason, fix } = privacy.failure;
    return check("Data directory", "problem", HOME_SUMMARIES[reason](home), fix);
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
    summary: "The server could not download or check the pinned engine.",
    fix: "Check this machine's internet connection and disk space, then restart the service.",
  },
  "credential-refused": {
    summary: "The engine refused the server's credential.",
    fix: "Restart the service. If it happens again, report it with the log.",
  },
};

const engineCheck = Effect.fn("doctor.engine")(function* (
  config: ServerConfig.ServerConfigShape,
  status: Option.Option<AdminStatus>,
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
      return check(
        "Engine",
        "warning",
        `T3 Code ${install.version} is not installed yet. The server downloads it, about 200 MB, on its first start.`,
        "Make sure this machine can reach github.com when the server first starts, or download it now with `j3-bots engine fetch`.",
      );
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
      return check("Engine", "warning", "The engine is starting.", "Run this again in a minute.");
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
      return check("Engine", "problem", reason.summary, reason.fix);
    }
  }
});

const providerCheck = Effect.fn("doctor.provider")(function* (
  harness: (typeof HARNESSES)[number],
  status: Option.Option<AdminStatus>,
  servicePath: Option.Option<string>,
) {
  const host = yield* Host;
  const found = yield* host.findExecutable(
    harness.executable,
    Option.getOrElse(servicePath, () => host.searchPath),
  );
  if (Option.isNone(found)) {
    return check(
      harness.name,
      "warning",
      Option.isSome(servicePath)
        ? `\`${harness.executable}\` is not on the service's PATH, so bots cannot run on ${harness.name}.`
        : `\`${harness.executable}\` is not on PATH, so bots cannot run on ${harness.name}.`,
      `Install ${harness.name}, or add its folder to PATH, then run \`j3-bots service install\` again so the service gets that PATH.`,
    );
  }
  if (Option.isNone(status)) {
    return check(
      harness.name,
      "ok",
      `Found at ${found.value}. Start the server to see what the engine reports about it.`,
    );
  }
  const providers = status.value.engine.providers.filter(
    (provider: ProviderStatus) => provider.harness === harness.harness,
  );
  if (providers.length === 0) {
    return check(
      harness.name,
      "warning",
      `Found at ${found.value}, but the server has no ${harness.name} provider set up, so no bot runs on it.`,
      "Update the server: a release that runs bots sets up a Claude Code and a Codex provider.",
    );
  }
  for (const provider of providers) {
    if (provider.status._tag === "sign-in-required") {
      return check(
        harness.name,
        "problem",
        `${provider.name} has no way to reach its models yet.`,
        `Run \`${provider.status.command}\` as this user. ${CONNECT_RESTARTS}`,
      );
    }
  }
  const unavailable = providers.find((provider) => provider.status._tag === "unavailable");
  if (unavailable !== undefined) {
    return check(
      harness.name,
      "problem",
      `The engine cannot run ${unavailable.name}.`,
      "Read why in the log: `journalctl --user -u j3-bots -n 100`.",
    );
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

/** The installed unit's text, if there is one. */
const installedUnit = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* Unit.unitPath).pipe(Effect.option);
});

const serviceChecks = Effect.fn("doctor.service")(function* (unitText: Option.Option<string>) {
  const systemd = yield* Systemd;
  if (!(yield* systemd.available)) {
    return [
      check(
        "Service",
        "warning",
        "There is no systemd user manager to run the server as a service.",
        "Run `j3-bots serve` yourself, or log in to a systemd session as this user.",
      ),
    ];
  }
  const checks: Array<Check> = [];
  if (Option.isNone(unitText)) {
    checks.push(
      check(
        "Service",
        "warning",
        "The service is not installed, so the server does not start on its own.",
        "Run `j3-bots service install`.",
      ),
    );
  } else {
    const unit = yield* systemd.unitState(Unit.UNIT_NAME);
    checks.push(
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
 * The configuration source the report describes: with the service installed,
 * the service's own (its home and `PATH`, none of this shell's overrides);
 * otherwise this shell's, which `j3-bots serve` would run with.
 */
const describedConfiguration = Effect.fn("doctor.describedConfiguration")(function* (
  unitText: Option.Option<string>,
) {
  if (Option.isNone(unitText)) return Layer.empty;
  const environment = Unit.environmentOf(unitText.value);
  const home = yield* Config.NonEmptyString("HOME");
  return Unit.asTheService({
    home,
    j3Home: environment.get("J3_HOME") ?? (yield* ServerConfig.resolveHome),
    searchPath: environment.get("PATH") ?? "",
  });
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
  const checks: Array<Check> = [nodeCheck(host.nodeVersion)];

  const unitText = yield* installedUnit;
  const described = yield* describedConfiguration(unitText);
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
    checks.push(yield* homeCheck(yield* ServerConfig.resolveHome.pipe(Effect.provide(described))));
    checks.push(serverCheck(live));
    checks.push(...(yield* serviceChecks(unitText)));
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

  // Only a server the report describes lends it live diagnostics.
  const status = live._tag === "described" ? Option.some(live.status) : Option.none();
  checks.push(serverCheck(live));
  switch (live._tag) {
    case "described":
      checks.push(runningPortsCheck(live.status));
      break;
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
  checks.push(yield* engineCheck(config, status));
  const servicePath = Option.flatMapNullishOr(unitText, (text) =>
    Unit.environmentOf(text).get("PATH"),
  );
  for (const harness of HARNESSES) checks.push(yield* providerCheck(harness, status, servicePath));
  checks.push(yield* webClientCheck(config, live, installation));
  checks.push(pairingCheck(status, live._tag === "outside"));
  checks.push(...(yield* serviceChecks(unitText)));
  if (Option.isSome(shellSettings)) checks.push(shellSettings.value);
  return checks;
});
