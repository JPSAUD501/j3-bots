// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Command } from "effect/cli";
import packageJson from "../../package.json" with { type: "json" };
import * as AdminClient from "../admin/AdminClient.ts";
import * as Host from "../system/Host.ts";
import * as Network from "../system/Network.ts";
import * as Systemd from "../system/Systemd.ts";
import { doctorCommand } from "./doctor.ts";
import { engineCommand } from "./engine.ts";
import { pairCommand } from "./pair.ts";
import { providerCommand } from "./provider.ts";
import { serveCommand } from "./serve.ts";
import { serviceCommand } from "./service.ts";
import { exportCommand, importCommand } from "./transfer.ts";
import { uninstallCommand } from "./uninstall.ts";
import { updateCommand } from "./update.ts";

const cli = Command.make("j3-bots").pipe(
  Command.withDescription(
    "J3 Bots: persistent AI teammates on your own machine. Start with `j3-bots doctor`.",
  ),
  Command.withSubcommands([
    serveCommand,
    doctorCommand,
    pairCommand,
    providerCommand,
    serviceCommand,
    engineCommand,
    updateCommand,
    exportCommand,
    importCommand,
    uninstallCommand,
  ]),
);

const runtime = Layer.mergeAll(
  Host.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  Systemd.layer,
  AdminClient.layer,
  Network.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

/** Runs the command line in `process.argv`. */
export const run = Command.run(cli, { version: packageJson.version }).pipe(Effect.provide(runtime));
