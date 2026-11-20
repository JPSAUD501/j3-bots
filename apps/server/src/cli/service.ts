// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import * as ServerConfig from "../config.ts";
import * as Installation from "../installation.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import { refuse, userFacing } from "./errors.ts";

// The server as a systemd user service: started at login, or at boot with
// lingering on, and restarted when it fails. Never with sudo: the service
// runs as the operator's user, in their home.

const LINGER_HINT = [
  "Lingering is off for this user, so the service stops when your last session ends and does not start at boot.",
  'Turn it on once with: sudo loginctl enable-linger "$(id -un)"',
].join("\n");

/** Settings the service will not see: it reads `config.json`, not this shell. */
const SHELL_ONLY_SETTINGS = [
  "J3_HOST",
  "J3_PORT",
  "J3_TOOL_PORT",
  "J3_ENGINE_PORT",
  "J3_WEB_CLIENT",
  "J3_TLS_CERT",
  "J3_TLS_KEY",
  "J3_ENGINE_BINARY",
];

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
      const systemd = yield* requireSystemd;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* Host;
      // The unit starts in the home, so it must exist before the first start.
      yield* userFacing(ServerConfig.initializeHome);
      const config = yield* userFacing(ServerConfig.load);

      const unit = yield* userFacing(
        Unit.render({
          node: process.execPath,
          entryPoint: yield* Installation.entryPoint,
          home: config.home,
          searchPath: host.searchPath,
          totalMemoryBytes: host.totalMemoryBytes,
        }),
      );
      const unitFile = yield* Unit.unitPath;
      yield* userFacing(fs.makeDirectory(path.dirname(unitFile), { recursive: true }));
      yield* userFacing(fs.writeFileString(unitFile, unit));
      yield* userFacing(systemd.reload);
      yield* userFacing(systemd.enableAndRestart(Unit.UNIT_NAME));

      const lines = [
        `Installed and started ${Unit.UNIT_NAME} (${unitFile}).`,
        `Data: ${config.home}. Settings: ${config.configFile}.`,
        "Logs: journalctl --user -u j3-bots -f",
      ];
      for (const name of SHELL_ONLY_SETTINGS) {
        if (Option.isSome(yield* Config.option(Config.String(name)))) {
          lines.push(
            `${name} is set in this shell, but the service does not get it. Put the setting in ${config.configFile} instead.`,
          );
        }
      }
      if ((yield* systemd.linger) !== "yes") lines.push("", LINGER_HINT);
      yield* Console.log(lines.join("\n"));
    }),
  ),
);

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
      yield* userFacing(systemd.disableAndStop(Unit.UNIT_NAME));
      yield* userFacing(fs.remove(unitFile));
      yield* userFacing(systemd.reload);
      const home = yield* userFacing(ServerConfig.resolveHome);
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
      const unitFile = yield* Unit.unitPath;
      if (!(yield* userFacing(fs.exists(unitFile)))) {
        return yield* Console.log(
          "The service is not installed. Install it with `j3-bots service install`.",
        );
      }
      const unit = yield* systemd.unitState(Unit.UNIT_NAME);
      const lines = [
        `${Unit.UNIT_NAME}: ${unit.active}, ${unit.enabled ? "enabled" : "not enabled"}.`,
      ];
      const config = yield* ServerConfig.load.pipe(Effect.option);
      if (Option.isSome(config)) {
        const admin = yield* AdminClient;
        const running = yield* admin.status(config.value.adminSocket).pipe(Effect.option);
        if (Option.isSome(running) && Option.isSome(running.value)) {
          lines.push(`J3 Bots ${running.value.value.version} answers on ${config.value.home}.`);
        }
      }
      if (unit.active === "failed") {
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
