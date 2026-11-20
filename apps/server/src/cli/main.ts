// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import packageJson from "../../package.json" with { type: "json" };
import * as AdminClient from "../admin/AdminClient.ts";
import * as Host from "../system/Host.ts";
import * as Network from "../system/Network.ts";
import * as Systemd from "../system/Systemd.ts";
import { doctorCommand } from "./doctor.ts";
import { pairCommand } from "./pair.ts";
import { serveCommand } from "./serve.ts";
import { serviceCommand } from "./service.ts";

const cli = Command.make("j3-bots").pipe(
  Command.withDescription(
    "J3 Bots: persistent AI teammates on your own machine. Start with `j3-bots doctor`.",
  ),
  Command.withSubcommands([serveCommand, doctorCommand, pairCommand, serviceCommand]),
);

const runtime = Layer.mergeAll(Host.layer, Systemd.layer, AdminClient.layer, Network.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Runs the command line in `process.argv`. */
export const run = Command.run(cli, { version: packageJson.version }).pipe(Effect.provide(runtime));
