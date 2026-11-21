// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as AdminSocket from "./admin/AdminSocket.ts";
import * as ServerConfig from "./config.ts";
import * as Domain from "./domain.ts";
import { engineProviders } from "./engine/providers.ts";
import * as Home from "./home/Home.ts";
import * as Http from "./http.ts";
import * as Installation from "./installation.ts";
import { SYSTEM_PROMPT_FILE } from "./home/entries.ts";
import * as Layout from "./Layout.ts";
import * as Listener from "./listener.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as BasePrompt from "./settings/BasePrompt.ts";
import * as SettingsStore from "./settings/SettingsStore.ts";
import * as SharedSkills from "./skills/SharedSkills.ts";
import * as Network from "./system/Network.ts";
import * as ToolEndpoint from "./tools/ToolEndpoint.ts";
import * as WebClient from "./web/WebClient.ts";

const logShutdown = Layer.effectDiscard(Effect.addFinalizer(() => Effect.logInfo("Shutting down")));

/**
 * The engine, run under `<J3_HOME>/engine`, writing only where the home's
 * containment check allows, with the Claude Code and Codex instances of
 * `engineProviders`. Each harness starts this package's `j3` bridge as the bot
 * tools' MCP server, pointed at the tool endpoint on loopback, and Codex takes
 * the base prompt as it changes.
 */
const engine = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const bridge = yield* Installation.bridgeEntryPoint;
    const layout = yield* Layout.Layout;
    const path = yield* Path.Path;
    const basePrompt = yield* BasePrompt.BasePrompt;
    return EngineLive.layer({
      home: config.engineHome,
      port: config.enginePort,
      binaryOverride: config.engineBinary,
      providers: engineProviders(path, config),
      toolBridge: {
        command: process.execPath,
        args: [bridge, "--server", `http://127.0.0.1:${config.toolPort}`],
      },
      systemPromptFile: SYSTEM_PROMPT_FILE,
      basePrompt: basePrompt.text,
      // The adapter's writes go through the same containment check as the server's.
      isPrivate: (location) => layout.writable(location).pipe(Effect.isSuccess),
    });
  }),
).pipe(Layer.provide(Layout.layer));

/**
 * The whole server. Built in dependency order: configuration, the home taken
 * for this process (a second server for the same home stops there, before it
 * opens the database), the migrated database, the engine and the domain, then
 * the client listener, and then the tool endpoint and the admin socket, which
 * reports where the client listener bound. The skills J3 Bots ships are
 * installed into the home beside them. Where it bound (`Listener`) is
 * made beneath them all, since the domain names it in a webhook's address. Each listener binds only once its
 * routes are built (`Ports.serve`). Interrupting it (SIGINT, SIGTERM) releases
 * everything in reverse.
 */
export const layer = Layer.mergeAll(
  ToolEndpoint.layer,
  AdminSocket.layer,
  SharedSkills.layer,
  logShutdown,
).pipe(
  Layer.provide(Http.serve(Listener.layer, { logAddress: true })),
  // One decision for the client routes and the admin socket's report.
  Layer.provide(WebClient.statusLayer),
  Layer.provide(Domain.layer),
  Layer.provide(engine),
  // One base prompt for the engine and the settings that change it.
  Layer.provide(BasePrompt.layer.pipe(Layer.provide(SettingsStore.layer))),
  Layer.provide(Sqlite.layer),
  Layer.provide(Home.layer),
  Layer.provide(Home.configLayer),
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Network.layer, Listener.unbound),
  ),
  Layer.provide(Logger.layer([Logger.consoleJson])),
);
