// SPDX-License-Identifier: AGPL-3.0-or-later
// The `j3` MCP server's process, started by a harness as
// `node src/bridge/main.ts --server http://127.0.0.1:<J3_TOOL_PORT>`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { sessionOfToolCaller } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stdio from "effect/Stdio";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import packageJson from "../../package.json" with { type: "json" };
import { serve } from "./Bridge.ts";

const main = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args;
  const server = args[args.indexOf("--server") + 1];
  if (!args.includes("--server") || server === undefined) {
    return yield* Effect.die("The bridge needs --server <tool endpoint origin>");
  }
  const environment = yield* Effect.sync(() => process.env);
  yield* serve({ server, session: sessionOfToolCaller(environment), version: packageJson.version });
});

main.pipe(
  // Standard output is the MCP channel: logs go to standard error.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(
    Layer.mergeAll(NodeStdio.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto),
  ),
  NodeRuntime.runMain,
);
