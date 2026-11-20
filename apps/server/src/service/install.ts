// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { AdminStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { replaceFile } from "../files.ts";
import * as Home from "../home/Home.ts";
import * as Installation from "../installation.ts";
import { Host } from "../system/Host.ts";
import { type PortState, portAdvice } from "../system/Ports.ts";
import { type Linger, Systemd } from "../system/Systemd.ts";
import { socketOwner } from "./owner.ts";
import * as Unit from "./unit.ts";

// `j3-bots service install`: the server as a systemd user service, started at
// login, or at boot with lingering on, and restarted when it fails. Never
// with sudo: the service runs as the operator's user, in their home.

/** How long a started service has to answer on its admin socket. */
const READY_WITHIN = Duration.seconds(60);

/** The service was not installed, or was installed and did not come up. */
class ServiceNotInstalled extends Schema.TaggedError<ServiceNotInstalled>()("ServiceNotInstalled", {
  reason: Schema.Literals([
    "configuration",
    "running-outside",
    "owner-unknown",
    "failed",
    "not-ready",
  ]),
  /**
   * For `configuration`, what the server would refuse; for `running-outside`,
   * the home; for `owner-unknown`, the admin socket.
   */
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "configuration":
        return `The service would not start, so it was left as it was: ${this.detail}`;
      case "running-outside":
        return `A J3 Bots server is already running for ${this.detail} outside the service. Stop it, then run this again.`;
      case "owner-unknown":
        return `A server answers on ${this.detail}, but not as this release does, and this system cannot tell whether it is the service's (the kernel's /proc does not say which process holds the socket). The unit was left as it was. Stop that server (\`systemctl --user stop j3-bots\` if it is the service), then run this again.`;
      case "failed":
        return "The service is installed, but the server failed to start. Read why with `journalctl --user -u j3-bots -n 100`.";
      case "not-ready":
        return `The service is installed and started, but the server did not answer within ${Duration.format(READY_WITHIN)}. Read why with \`journalctl --user -u j3-bots -n 100\`.`;
    }
  }
}

interface Installed {
  readonly unitFile: string;
  readonly config: ServerConfig.ServerConfigShape;
  /** What the server the service started says of itself. */
  readonly server: AdminStatus;
  /** Overrides set in this shell, which the service does not get. */
  readonly overrides: ReadonlyArray<(typeof ServerConfig.SHELL_OVERRIDES)[number]>;
  readonly linger: Linger;
}

/**
 * Waits, within `READY_WITHIN`, for the started service's own server to
 * answer on its admin socket. Another process answering is not it.
 */
const awaitServer = Effect.fn("service.awaitServer")(function* (socket: string) {
  const poll = Effect.gen(function* () {
    const { owner, status, unit } = yield* socketOwner(socket);
    if (owner === "service" && Option.isSome(status)) {
      return { _tag: "ready", status: status.value } as const;
    }
    return unit.active === "failed"
      ? ({ _tag: "failed" } as const)
      : ({ _tag: "waiting" } as const);
  });
  const outcome = yield* poll.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(500)),
      until: (state) => state._tag !== "waiting",
    }),
    Effect.timeoutOption(READY_WITHIN),
  );
  if (Option.isNone(outcome) || outcome.value._tag === "waiting") {
    return yield* new ServiceNotInstalled({ reason: "not-ready", detail: "" });
  }
  if (outcome.value._tag === "failed") {
    return yield* new ServiceNotInstalled({ reason: "failed", detail: "" });
  }
  return outcome.value.status;
});

/** Why listening on `host`, at a port the system picked, failed. */
const addressRefusal = (
  state: Exclude<PortState, { _tag: "free" | "not-local" }>,
  host: string,
) => {
  switch (state._tag) {
    case "denied":
      return `This user may not listen on ${host}.`;
    case "in-use":
      return `No port on ${host} was free to listen on.`;
    case "failed":
      return `Listening on ${host} failed with ${state.code}.`;
  }
};

/**
 * Writes the unit, whole, enables it and (re)starts it, then waits for the
 * server to answer. Checked first: the configuration, as the service will run
 * it (the home, its `config.json` and the service's `PATH`, none of this
 * shell's overrides); the home, as the server checks it at start; the admin
 * socket's path; and that this user can listen on `host`. A refusal by any of
 * these leaves the installed unit untouched, and a refused configuration
 * leaves the home as it was.
 */
export const install = Effect.gen(function* () {
  const systemd = yield* Systemd;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* Host;

  const home = yield* ServerConfig.resolveHome;
  const searchPath = yield* Unit.servicePath(
    host.searchPath,
    yield* Config.option(Config.NonEmptyString("XDG_RUNTIME_DIR")),
  );
  const config = yield* Effect.gen(function* () {
    // The unit starts in the home, so it is created here, once its configuration passes.
    const loaded = yield* Home.initialize;
    yield* Home.checkSocketPath(loaded.adminSocket);
    return loaded;
  }).pipe(
    Effect.provide(
      Unit.asTheService({ home: yield* Config.NonEmptyString("HOME"), j3Home: home, searchPath }),
    ),
    Effect.mapError(
      (refusal) => new ServiceNotInstalled({ reason: "configuration", detail: refusal.message }),
    ),
  );

  // The address must still be this machine's: its own port is the running
  // service's to hold, so a free one the system picks stands in for it.
  const address = yield* host.portState(config.host, 0);
  if (address._tag !== "free") {
    // Only the address was tried, never the configured port, so only the address is named.
    const { summary, fix } =
      address._tag === "not-local"
        ? portAdvice(
            address,
            { label: "the server", setting: "port", host: config.host, port: config.port },
            config.configFile,
          )
        : {
            summary: addressRefusal(address, config.host),
            fix: `Check "host" in ${config.configFile}.`,
          };
    return yield* new ServiceNotInstalled({ reason: "configuration", detail: `${summary} ${fix}` });
  }

  // One server per home: the service's would only wait behind another's lock.
  // The service's own is replaced by the restart.
  switch ((yield* socketOwner(config.adminSocket)).owner) {
    case "other":
      return yield* new ServiceNotInstalled({ reason: "running-outside", detail: config.home });
    case "unknown":
      return yield* new ServiceNotInstalled({
        reason: "owner-unknown",
        detail: config.adminSocket,
      });
  }

  const unit = yield* Unit.render({
    node: yield* fs.realPath(process.execPath),
    entryPoint: yield* Installation.entryPoint,
    home: config.home,
    searchPath,
    totalMemoryBytes: host.totalMemoryBytes,
  });
  const unitFile = yield* Unit.unitPath;
  yield* fs.makeDirectory(path.dirname(unitFile), { recursive: true });
  yield* replaceFile(unitFile, unit, 0o644);
  yield* systemd.reload;
  yield* systemd.enableAndRestart(Unit.UNIT_NAME);

  const server = yield* awaitServer(config.adminSocket);
  return {
    unitFile,
    config,
    server,
    overrides: yield* ServerConfig.shellOverrides,
    linger: yield* systemd.linger,
  } satisfies Installed;
});
