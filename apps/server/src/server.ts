// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EngineLive from "@j3-bots/engine-t3/live";
import { preApprovedTools } from "@j3-bots/prompts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as AdminSocket from "./admin/AdminSocket.ts";
import * as ServerConfig from "./config.ts";
import * as OAuthEndpoints from "./connectors/oauth/endpoints.ts";
import * as McpRegistry from "./connectors/sources/Registry.ts";
import * as Domain from "./domain.ts";
import { claimEngineRelease } from "./engine/EngineRelease.ts";
import { engineProviders } from "./engine/providers.ts";
import { ownExecutables } from "./harnesses/layout.ts";
import * as HarnessSources from "./harnesses/sources.ts";
import * as Home from "./home/Home.ts";
import * as Http from "./http.ts";
import * as Installation from "./installation.ts";
import { SYSTEM_PROMPT_FILE, WORKSPACE_ENTRIES } from "./home/entries.ts";
import * as Layout from "./Layout.ts";
import * as Listener from "./listener.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as ReleaseFeed from "./releases/ReleaseFeed.ts";
import * as ExpoPushSender from "./push/ExpoPushSender.ts";
import * as BasePrompt from "./settings/BasePrompt.ts";
import * as SettingsStore from "./settings/SettingsStore.ts";
import * as SuggestReplies from "./settings/SuggestReplies.ts";
import * as SharedSkills from "./skills/SharedSkills.ts";
import * as SkillRepositories from "./skills/SkillRepositories.ts";
import * as Host from "./system/Host.ts";
import * as Network from "./system/Network.ts";
import * as Systemd from "./system/Systemd.ts";
import { CONNECTOR_CALL_DEADLINE } from "./tools/protocol.ts";
import * as BridgeKey from "./tools/BridgeKey.ts";
import * as ToolEndpoint from "./tools/ToolEndpoint.ts";
import * as UpdateLauncher from "./update/UpdateLauncher.ts";
import * as UpdateRuns from "./update/UpdateRuns.ts";
import * as RefusedNames from "./web/RefusedNames.ts";
import * as WebClient from "./web/WebClient.ts";

const logShutdown = Layer.effectDiscard(Effect.addFinalizer(() => Effect.logInfo("Shutting down")));

/**
 * The engine, run under `<J3_HOME>/engine`, writing only where the home's
 * containment check allows, with the Claude Code and Codex instances of
 * `engineProviders`, once the database shows no newer engine ran on its data
 * (`claimEngineRelease`). Each harness starts this package's `j3` bridge as
 * the bot tools' MCP server, pointed at the tool endpoint on loopback with the
 * key it signs its requests with, Codex takes the base prompt as it changes,
 * and both list the shared skills, among them the ones J3 Bots ships,
 * installed here first.
 */
const engine = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const bridge = (yield* Installation.installation).bridgeEntryPoint;
    const layout = yield* Layout.Layout;
    const path = yield* Path.Path;
    const basePrompt = yield* BasePrompt.BasePrompt;
    const suggestReplies = yield* SuggestReplies.SuggestReplies;
    // Before the engine's first start, which links the shared skills into each harness home.
    yield* SharedSkills.install();
    // The copies J3 Bots installed of the harnesses, which the engine runs from its start.
    const executables = yield* ownExecutables(config.home);
    const bridgeKey = yield* BridgeKey.BridgeKey;
    // An engine build under test is not the pinned release, which is then
    // neither checked nor recorded.
    if (Option.isNone(config.engineBinary)) yield* claimEngineRelease(EngineLive.pinnedRelease);
    return EngineLive.layer({
      home: config.engineHome,
      port: config.enginePort,
      binaryOverride: config.engineBinary,
      providers: engineProviders(path, config, executables),
      toolBridge: {
        command: process.execPath,
        args: [bridge, "--server", `http://127.0.0.1:${config.toolPort}`],
        // The key it signs its requests with, which only it and the endpoint hold.
        environment: [bridgeKey.variable],
        // J3 Bots' own tools run without asking, but those that change its MCP
        // servers and skills; those and a connector's follow the bot's permission mode.
        preApproved: preApprovedTools,
        callTimeoutSeconds: Duration.toSeconds(CONNECTOR_CALL_DEADLINE) + 60,
      },
      systemPromptFile: SYSTEM_PROMPT_FILE,
      basePrompt: basePrompt.text,
      suggestReplies: suggestReplies.enabled,
      sharedSkills: layout.sharedSkills,
      botSkills: WORKSPACE_ENTRIES.skills,
      // The adapter's writes go through the same containment check as the server's.
      isPrivate: (location) => layout.writable(location).pipe(Effect.isSuccess),
    });
  }),
).pipe(Layer.provide(Layout.layer));

/**
 * The whole server. Built in dependency order: configuration, the home taken
 * for this process (a second server for the same home stops there, before it
 * opens the database), the migrated database, the shipped skills and the
 * engine that links them into each harness home, with the push sender (Expo's),
 * the domain, then the client listener, and then the tool endpoint and the
 * admin channels, which report where the client listener bound: the admin
 * socket where the system has one (`hasAdminSocket`), and with `adminFd` the
 * pipe inherited there. Where it bound
 * (`Listener`) is made beneath them all, since the domain names it in a
 * webhook's address. Each listener binds only once its routes are built
 * (`Ports.serve`). Releasing it, on SIGINT or SIGTERM or once a stop is asked
 * for (`ServerStop`), releases everything in reverse.
 */
export const layer = (options: { readonly adminFd: Option.Option<number> }) =>
  Layer.mergeAll(
    ToolEndpoint.layer,
    AdminSocket.layer,
    Option.match(options.adminFd, { onNone: () => Layer.empty, onSome: AdminSocket.pipeLayer }),
    logShutdown,
  ).pipe(
    Layer.provide(Http.serve(Listener.layer, { logAddress: true })),
    // Checks for newer releases for as long as the server runs.
    Layer.provideMerge(ReleaseFeed.layer),
    Layer.provide(
      UpdateRuns.layer.pipe(
        // The desktop app runs its own server with `--admin-fd`, and updates it with itself.
        Layer.provide(UpdateLauncher.layer(Option.isSome(options.adminFd) ? "desktop" : "cli")),
        Layer.provide(Layer.merge(Systemd.layer, Host.layer)),
      ),
    ),
    // One decision for the client routes and the admin socket's report, and
    // one record of the names the client listener refused, which it reports too.
    Layer.provide(Layer.merge(WebClient.statusLayer, RefusedNames.layer)),
    Layer.provide(Domain.layer),
    Layer.provide(
      Layer.mergeAll(
        engine,
        ExpoPushSender.layer,
        OAuthEndpoints.layer,
        HarnessSources.layer.pipe(Layer.provide(Host.layer)),
      ),
    ),
    Layer.provide(Layer.merge(McpRegistry.layer, SkillRepositories.layer)),
    // One key, made for this start, for the bridges the engine starts and the endpoint they reach.
    Layer.provideMerge(BridgeKey.layer),
    // One base prompt, and one switch for suggested replies, for the engine
    // and the settings that change them.
    Layer.provide(
      Layer.merge(BasePrompt.layer, SuggestReplies.layer).pipe(Layer.provide(SettingsStore.layer)),
    ),
    Layer.provide(Sqlite.layer),
    Layer.provide(Home.layer),
    Layer.provide(Home.configLayer),
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Network.layer, Listener.unbound),
    ),
    Layer.provide(Logger.layer([Logger.consoleJson])),
  );
