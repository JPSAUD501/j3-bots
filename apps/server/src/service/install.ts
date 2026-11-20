// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { AdminClient } from "../admin/AdminClient.ts";
import type { AdminStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import * as Home from "../home/Home.ts";
import * as Installation from "../installation.ts";
import { Host } from "../system/Host.ts";
import { type Linger, Systemd } from "../system/Systemd.ts";
import * as Unit from "./unit.ts";

// `j3-bots service install`: the server as a systemd user service, started at
// login, or at boot with lingering on, and restarted when it fails. Never
// with sudo: the service runs as the operator's user, in their home.

/** How long a started service has to answer on its admin socket. */
const READY_WITHIN = Duration.seconds(60);

/** The service was not installed, or was installed and did not come up. */
class ServiceNotInstalled extends Schema.TaggedError<ServiceNotInstalled>()("ServiceNotInstalled", {
  reason: Schema.Literals(["configuration", "failed", "not-ready"]),
  /** For `configuration`, what the server would refuse. */
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "configuration":
        return `The service would not start, so it was left as it was: ${this.detail}`;
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

/** Waits, within `READY_WITHIN`, for the started server to answer on its admin socket. */
const awaitServer = Effect.fn("service.awaitServer")(function* (socket: string) {
  const admin = yield* AdminClient;
  const systemd = yield* Systemd;
  const poll = Effect.gen(function* () {
    const answer = yield* admin.status(socket).pipe(Effect.option, Effect.map(Option.flatten));
    if (Option.isSome(answer)) return { _tag: "ready", status: answer.value } as const;
    const unit = yield* systemd.unitState(Unit.UNIT_NAME);
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

/**
 * Writes the unit, enables it and (re)starts it, then waits for the server to
 * answer. The configuration is checked first as the service will run it (the
 * home, its `config.json` and the service's `PATH`, none of this shell's
 * overrides), and a configuration the server would refuse leaves the
 * installed unit untouched.
 */
export const install = Effect.gen(function* () {
  const systemd = yield* Systemd;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* Host;

  // The unit starts in the home, so it must exist before the first start.
  yield* ServerConfig.initializeHome;
  const home = yield* ServerConfig.resolveHome;
  const searchPath = yield* Unit.servicePath(
    host.searchPath,
    yield* Config.option(Config.NonEmptyString("XDG_RUNTIME_DIR")),
  );
  const asTheService = ConfigProvider.fromEnvRecord({
    HOME: yield* Config.NonEmptyString("HOME"),
    J3_HOME: home,
    PATH: searchPath,
  });
  const config = yield* Effect.gen(function* () {
    yield* Home.checkPrivate(home);
    return yield* ServerConfig.load;
  }).pipe(
    Effect.provide(ConfigProvider.layer(asTheService)),
    Effect.mapError(
      (refusal) => new ServiceNotInstalled({ reason: "configuration", detail: refusal.message }),
    ),
  );

  const unit = yield* Unit.render({
    node: yield* fs.realPath(process.execPath),
    entryPoint: yield* Installation.entryPoint,
    home: config.home,
    searchPath,
    totalMemoryBytes: host.totalMemoryBytes,
  });
  const unitFile = yield* Unit.unitPath;
  yield* fs.makeDirectory(path.dirname(unitFile), { recursive: true });
  yield* fs.writeFileString(unitFile, unit);
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
