// SPDX-License-Identifier: AGPL-3.0-or-later
// The `j3` MCP server's process, started by a harness as
// `node src/bridge/main.ts --server http://127.0.0.1:<J3_TOOL_PORT>`.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { sessionOfToolCaller } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stdio from "effect/Stdio";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import packageJson from "../../package.json" with { type: "json" };
import { BRIDGE_KEY_VARIABLE } from "../tools/protocol.ts";
import { serve } from "./Bridge.ts";

const main = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args;
  const server = args[args.indexOf("--server") + 1];
  if (!args.includes("--server") || server === undefined) {
    return yield* Effect.die("The bridge needs --server <tool endpoint origin>");
  }
  const environment = yield* Effect.sync(() => process.env);
  yield* serve({
    server,
    session: sessionOfToolCaller(environment),
    key: Option.fromNullishOr(environment[BRIDGE_KEY_VARIABLE]),
    version: packageJson.version,
  });
});

main.pipe(
  // Standard output is the MCP channel: logs go to standard error.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(
    Layer.mergeAll(
      NodeStdio.layer,
      // Node's own client, which waits for an answer as long as the bridge's
      // deadline: `fetch` gives up on a response whose headers take five
      // minutes, which a connector's call can.
      NodeHttpClient.layerNodeHttp,
      Mac.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto)),
    ),
  ),
  NodeRuntime.runMain,
);
