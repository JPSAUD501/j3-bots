// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { install as installService } from "../service/install.ts";
import * as Unit from "../service/unit.ts";
import { Systemd } from "../system/Systemd.ts";
import { refuse, userFacing } from "./errors.ts";

const LINGER_HINT = [
  "Lingering is off for this user, so the service stops when your last session ends and does not start at boot.",
  'Turn it on once with: sudo loginctl enable-linger "$(id -un)"',
].join("\n");

const ENGINE_STATES: Record<EngineStatus["state"]["_tag"], string> = {
  starting: "starting",
  ready: "ready",
  unavailable: "not available yet",
  incompatible: "not the version this release needs",
};

const requireSystemd = Effect.gen(function* () {
  const systemd = yield* Systemd;
  if (!(yield* systemd.available)) {
    return yield* refuse(
      "There is no systemd user manager to install the service in. Log in to a systemd session as this user (not with sudo), or run `j3-bots serve` yourself.",
    );
  }
  return systemd;
});

const install = Command.make("install").pipe(
  Command.withDescription(
    "Install the server as a systemd user service, enabled and started. Run it again after an update or after changing PATH.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* requireSystemd;
      const installed = yield* userFacing(installService);
      const { config, server } = installed;
      const lines = [
        `Installed and started ${Unit.UNIT_NAME} (${installed.unitFile}). J3 Bots ${server.version} answers.`,
        `The engine is ${ENGINE_STATES[server.engine.state._tag]}; \`j3-bots doctor\` says more.`,
        `Data: ${config.home}. Settings: ${config.configFile}.`,
        "Logs: journalctl --user -u j3-bots -f",
        ...installed.overrides.map((name) => ServerConfig.overrideNote(name, config.configFile)),
      ];
      if (installed.linger !== "yes") lines.push("", LINGER_HINT);
      yield* Console.log(lines.join("\n"));
    }),
  ),
);

/**
 * The home the installed unit runs its server with, from the unit itself;
 * this shell's when the unit names none.
 */
const serviceHome = Effect.fn("service.serviceHome")(function* (unitFile: string) {
  const installed = yield* userFacing(Unit.installedHome(unitFile));
  return Option.isSome(installed) ? installed.value : yield* userFacing(ServerConfig.resolveHome);
});

const uninstall = Command.make("uninstall").pipe(
  Command.withDescription("Stop the service and remove it. The data directory is kept."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const systemd = yield* requireSystemd;
      const fs = yield* FileSystem.FileSystem;
      const unitFile = yield* Unit.unitPath;
      if (!(yield* userFacing(fs.exists(unitFile)))) {
        return yield* Console.log("The service is not installed.");
      }
      const home = yield* serviceHome(unitFile);
      yield* userFacing(systemd.disableAndStop(Unit.UNIT_NAME));
      yield* userFacing(fs.remove(unitFile));
      yield* userFacing(systemd.reload);
      yield* Console.log(`Stopped and removed ${Unit.UNIT_NAME}. Your data in ${home} is kept.`);
    }),
  ),
);

const status = Command.make("status").pipe(
  Command.withDescription(
    "Say whether the service is installed, running and set to start at boot.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const systemd = yield* requireSystemd;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const unitFile = yield* Unit.unitPath;
      if (!(yield* userFacing(fs.exists(unitFile)))) {
        return yield* Console.log(
          "The service is not installed. Install it with `j3-bots service install`.",
        );
      }
      const home = yield* serviceHome(unitFile);
      const unit = yield* systemd.unitState(Unit.UNIT_NAME);
      const lines = [
        `${Unit.UNIT_NAME}: ${unit.active}, ${unit.enabled ? "enabled" : "not enabled"}. Data: ${home}.`,
      ];
      const admin = yield* AdminClient;
      const running = yield* admin
        .status(path.join(home, HOME_ENTRIES.adminSocket))
        .pipe(Effect.option, Effect.map(Option.flatten));
      // Only the service's own server: another one may hold the home meanwhile.
      if (
        Option.isSome(running) &&
        unit.active === "active" &&
        Option.contains(unit.mainPid, running.value.pid)
      ) {
        const { version, listener } = running.value;
        lines.push(`J3 Bots ${version} answers, listening on port ${listener.port}.`);
      }
      if (unit.active === "failed" || unit.active === "activating") {
        lines.push("Read why with: journalctl --user -u j3-bots -n 100");
      }
      if ((yield* systemd.linger) !== "yes") lines.push("", LINGER_HINT);
      yield* Console.log(lines.join("\n"));
    }),
  ),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Run the server as a systemd user service."),
  Command.withSubcommands([install, uninstall, status]),
);
