// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import rootPackage from "../../../../package.json" with { type: "json" };
import { AdminClient } from "../admin/AdminClient.ts";
import type { AdminStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";

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

const homeCheck = Effect.fn("doctor.home")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(Effect.option);
  if (Option.isNone(info)) {
    return check(
      "Data directory",
      "ok",
      `${home} does not exist yet; the server creates it on its first start.`,
    );
  }
  if (info.value.type !== "Directory") {
    return check(
      "Data directory",
      "problem",
      `${home} is not a folder.`,
      "Move it away, or set J3_HOME to another folder.",
    );
  }
  const writable = yield* fs.access(home, { writable: true }).pipe(Effect.isSuccess);
  if (!writable) {
    return check(
      "Data directory",
      "problem",
      `${home} is not writable by this user.`,
      `Give it back to this user: \`chown -R "$(id -un)" ${home}\`.`,
    );
  }
  if ((info.value.mode & 0o077) !== 0) {
    return check(
      "Data directory",
      "warning",
      `Other users on this machine can read ${home}, which holds the database and the bots' files.`,
      `Run \`chmod 700 ${home}\`.`,
    );
  }
  return check("Data directory", "ok", `${home}, readable by this user only.`);
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

const portsCheck = Effect.fn("doctor.ports")(function* (
  config: ServerConfig.ServerConfigShape,
  running: boolean,
) {
  if (running) {
    return check(
      "Ports",
      "ok",
      `The running server holds ${config.port}, ${config.toolPort} and ${config.enginePort}.`,
    );
  }
  const host = yield* Host;
  const settingHint = `in ${config.configFile}`;
  const wanted = [
    { label: "the server", host: config.host, port: config.port, setting: "port" },
    { label: "the bot tools", host: "127.0.0.1", port: config.toolPort, setting: "toolPort" },
    { label: "the engine", host: "127.0.0.1", port: config.enginePort, setting: "enginePort" },
  ];
  for (const { label, host: address, port, setting } of wanted) {
    const state = yield* host.portState(address, port);
    switch (state) {
      case "free":
        continue;
      case "in-use":
        return check(
          "Ports",
          "problem",
          `Port ${port}, for ${label}, is in use by another program.`,
          `Stop that program (\`ss -ltnp 'sport = :${port}'\` names it), or set "${setting}" ${settingHint} to a free port.`,
        );
      case "not-local":
        return check(
          "Ports",
          "problem",
          `${address} is not an address of this machine, so the server cannot listen on it.`,
          `Set "host" ${settingHint} to "lan" or to one of this machine's addresses (\`ip -4 addr\`).`,
        );
      case "denied":
        return check(
          "Ports",
          "problem",
          `This user may not listen on ${address}:${port}.`,
          `Set "${setting}" ${settingHint} to a port above 1023.`,
        );
    }
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
        "Make sure this machine can reach github.com when the server first starts.",
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
) {
  const host = yield* Host;
  const found = yield* host.findExecutable(harness.executable);
  if (Option.isNone(found)) {
    return check(
      harness.name,
      "warning",
      `\`${harness.executable}\` is not on PATH, so bots cannot run on ${harness.name}.`,
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
      "This release of the server sets up no provider yet; one that does is needed to run bots.",
    );
  }
  const signedOut = providers.find((provider) => provider.status._tag === "sign-in-required");
  if (signedOut !== undefined) {
    return check(
      harness.name,
      "problem",
      `${signedOut.name} is not signed in.`,
      `Sign in to ${harness.name} again for J3 Bots, then restart the service.`,
    );
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

const webClientCheck = Effect.fn("doctor.webClient")(function* (
  config: ServerConfig.ServerConfigShape,
  status: Option.Option<AdminStatus>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const built = yield* fs
    .exists(path.join(config.webClient.directory, "index.html"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!built) {
    return check(
      "Web client",
      "warning",
      `No web client is built in ${config.webClient.directory}, so the server serves only its API.`,
      "Build it with `pnpm --filter @j3-bots/web build`, then restart the service.",
    );
  }
  if (Option.isSome(status) && status.value.webClient === "not-built") {
    return check(
      "Web client",
      "warning",
      "The web client was built after the server started, so it is not served yet.",
      "Restart the service: `systemctl --user restart j3-bots`.",
    );
  }
  return check("Web client", "ok", `Served from ${config.webClient.directory}.`);
});

const pairingCheck = (status: Option.Option<AdminStatus>) => {
  if (Option.isNone(status)) {
    return check("Pairing", "skipped", "Start the server to see which devices are paired.");
  }
  const count = status.value.pairedDevices;
  return count === 0
    ? check(
        "Pairing",
        "warning",
        "No device is paired yet.",
        "Run `j3-bots pair` and enter the code in the web client.",
      )
    : check(
        "Pairing",
        "ok",
        count === 1 ? "One device is paired." : `${count} devices are paired.`,
      );
};

const serviceChecks = Effect.gen(function* () {
  const systemd = yield* Systemd;
  const fs = yield* FileSystem.FileSystem;
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
  const unitFile = yield* Unit.unitPath;
  if (!(yield* fs.exists(unitFile).pipe(Effect.orElseSucceed(() => false)))) {
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
      unit.active === "failed"
        ? check(
            "Service",
            "problem",
            "The service has failed.",
            "Read why with `journalctl --user -u j3-bots -n 100`, then `systemctl --user restart j3-bots`.",
          )
        : unit.active !== "active" && unit.active !== "activating"
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
  checks.push(
    linger === "yes"
      ? check("Start at boot", "ok", "Lingering is on: the service runs without a login session.")
      : check(
          "Start at boot",
          "warning",
          linger === "no"
            ? "Lingering is off: the service stops when this user's last session ends and does not start at boot."
            : "Could not tell whether lingering is on for this user.",
          'Run `sudo loginctl enable-linger "$(id -un)"` once.',
        ),
  );

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

/** Every check, in the order the report shows them. */
export const diagnose = Effect.gen(function* () {
  const host = yield* Host;
  const admin = yield* AdminClient;
  const checks: Array<Check> = [nodeCheck(host.nodeVersion)];

  const loaded = yield* ServerConfig.load.pipe(Effect.result);
  if (loaded._tag === "Failure") {
    checks.push(
      check(
        "Configuration",
        "problem",
        loaded.failure.message,
        "Fix the setting it names, then run this again.",
      ),
    );
    checks.push(yield* homeCheck(yield* ServerConfig.resolveHome));
    checks.push(...(yield* serviceChecks));
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

  const answer = yield* admin.status(config.adminSocket).pipe(Effect.result);
  const status = answer._tag === "Success" ? answer.success : Option.none();
  checks.push(
    answer._tag === "Failure"
      ? check(
          "Server",
          "problem",
          "A server answers on the admin socket, but not as expected.",
          "Restart it: `systemctl --user restart j3-bots`.",
        )
      : Option.isSome(status)
        ? check(
            "Server",
            "ok",
            `J3 Bots ${status.value.version} is running on port ${config.port}.`,
          )
        : check(
            "Server",
            "warning",
            "The server is not running.",
            "Start it with `systemctl --user start j3-bots`, or `j3-bots serve` in a terminal.",
          ),
  );
  checks.push(yield* portsCheck(config, Option.isSome(status) || answer._tag === "Failure"));
  checks.push(yield* engineCheck(config, status));
  for (const harness of HARNESSES) checks.push(yield* providerCheck(harness, status));
  checks.push(yield* webClientCheck(config, status));
  checks.push(pairingCheck(status));
  checks.push(...(yield* serviceChecks));
  return checks;
});
