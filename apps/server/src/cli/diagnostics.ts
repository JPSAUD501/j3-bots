// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { diagnosticsFileName } from "@j3-bots/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import packageJson from "../../package.json" with { type: "json" };
import { AdminClient } from "../admin/AdminClient.ts";
import { hasAdminSocket } from "../admin/socket.ts";
import * as ServerConfig from "../config.ts";
import { diagnosticsZip, type InstallKind } from "../diagnostics/build.ts";
import * as Installation from "../installation.ts";
import * as Unit from "../service/unit.ts";
import { refuse, userFacing } from "./errors.ts";

// `j3-bots diagnostics` (docs/operations/operating.md, "Diagnostics"): the
// zip a client downloads from Settings → About, made on the server's machine,
// for when no client can reach it. It reads the data directory and changes
// nothing, with the server running or stopped.

const outFlag = Flag.String("out").pipe(
  Flag.withDescription(
    "The file to write the zip to, which must not exist yet. When left out, j3-bots-diagnostics-<date>-<time>.zip in this folder.",
  ),
  Flag.optional,
);

/**
 * How J3 Bots is installed here, as far as a command can tell: from a
 * checkout, as the installed service, or a release run by hand.
 */
const installKind = (service: boolean) =>
  Installation.installation.pipe(
    Effect.map((found): InstallKind =>
      found.layout._tag === "checkout" ? "checkout" : service ? "service" : "release",
    ),
    Effect.orElseSucceed((): InstallKind => "release"),
  );

export const diagnosticsCommand = Command.make("diagnostics", { out: outFlag }).pipe(
  Command.withDescription(
    "Write a zip that says how this server runs, to send to whoever helps you: its log and the engine's for the last 7 days, what failed, the versions, settings and counts. It holds no messages, no names and no secrets; README.md inside lists what it holds. Acts on the installed service's server, else on the one `j3-bots serve` runs from this shell, running or stopped. Changes nothing.",
  ),
  Command.withHandler(({ out }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const unitText = yield* Unit.installedUnit;
      const described = yield* userFacing(Unit.describedConfiguration(unitText));
      const config = yield* userFacing(ServerConfig.load.pipe(Effect.provide(described)));
      const at = yield* DateTime.now;
      const file = path.resolve(Option.getOrElse(out, () => diagnosticsFileName(at)));
      if (!(yield* fs.exists(config.databasePath))) {
        return yield* refuse(
          `No server has run on ${config.home} yet, so there is nothing to put in a diagnostics zip. Start it once with \`j3-bots serve\` or \`j3-bots service install\`.`,
        );
      }
      // The file is made here, and only here: anything already at its name, a
      // link included, is refused and left as it is. Once made, it is removed
      // again when no whole zip is written, however that ends, and only once
      // it is closed, which Windows needs.
      let made = false;
      const running = yield* Effect.gen(function* () {
        const handle = yield* fs
          .open(file, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? refuse(`${file} already exists. Name another file with --out.`)
                : refuse(`${file} could not be written.`),
            ),
          );
        made = true;
        // The running server, when one answers, says what only it knows: the
        // engine's state and when it started. Without one, the zip says so.
        const running = hasAdminSocket(process.platform)
          ? yield* (yield* AdminClient)
              .status(config.adminSocket)
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        const sql = yield* SqliteClient.make({
          filename: config.databasePath,
          readonly: true,
        }).pipe(
          Effect.provide(Reactivity.layer),
          Effect.mapError(() =>
            refuse(`The database in ${config.home} could not be opened, so no zip was written.`),
          ),
        );
        const zip = yield* diagnosticsZip(config, {
          at,
          client: Option.none(),
          version: Option.match(running, {
            onNone: () => packageJson.version,
            onSome: (status) => status.version,
          }),
          startedAt: Option.map(running, (status) => status.startedAt),
          install: yield* installKind(Option.isSome(unitText)),
          engine: Option.map(running, (status) => status.engine),
          secrets: [],
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        yield* zip.pipe(
          Stream.runForEach((chunk) => handle.writeAll(chunk)),
          Effect.mapError(() => refuse(`${file} could not be written.`)),
        );
        return running;
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && made
            ? fs.remove(file, { force: true }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      yield* Console.log(
        [
          `Wrote ${file}.`,
          Option.isNone(running)
            ? "The server is not running, so the zip does not say how the engine and its providers are."
            : "",
          "It holds no messages, no names and no secrets. README.md inside lists what it holds: read it, then send the file to whoever helps you.",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      );
    }).pipe(Effect.scoped),
  ),
);
