// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import type { SessionId } from "@j3-bots/engine-t3";
import { browserToolList, connectorSkillsDescription, toolList } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { BotStore } from "../bots/BotStore.ts";
import { EngineSessions } from "../bots/EngineSessions.ts";
import { browserSwitches } from "../browser/switches.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { Ids } from "../Ids.ts";
import type {
  ListedTool,
  ToolChangesRequest,
  ToolChangesResponse,
  ToolListResponse,
} from "./protocol.ts";

/**
 * How long one wait for a change lasts before it answers with no change, so
 * a bridge whose harness is gone stops holding a request open.
 */
const CHANGE_WAIT = Duration.minutes(4);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const listed = (tool: (typeof toolList)[number]): ListedTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: decodeJson(tool.inputSchema).pipe(
    Option.getOrElse((): Schema.Json => ({ type: "object" })),
  ),
  _meta: { ...tool._meta },
});

/** J3 Bots' own tools, as every bridge lists them first. */
const ownTools: ReadonlyArray<ListedTool> = toolList.map(listed);

/** The browser's tools, listed after J3 Bots' own to a bot whose browser is on (decision 0110). */
const browserTools: ReadonlyArray<ListedTool> = browserToolList.map(listed);

/**
 * J3 Bots' own tools for a bot: `use_connector_skill` lists the skills its
 * connectors serve in its description (decision 0089).
 */
const ownToolsWith = (skills: Parameters<typeof connectorSkillsDescription>[1]) =>
  skills.length === 0
    ? ownTools
    : ownTools.map((tool) =>
        tool.name === "use_connector_skill"
          ? { ...tool, description: connectorSkillsDescription(tool.description, skills) }
          : tool,
      );

/**
 * The tools each `j3` bridge lists for its session: J3 Bots' own, the
 * browser's while the bot's browser is on, then the connector tools its bot
 * is offered (`docs/architecture/server.md`, Bot tools). Each bot's list has
 * a version, which changes whenever its offered tools may have, and which no
 * other server process gives, so a bridge that outlives a restart of the
 * server also learns its list may have changed.
 */
export class ToolLists extends Context.Service<
  ToolLists,
  {
    readonly list: (sessionId: SessionId) => Effect.Effect<ToolListResponse>;
    /**
     * Answers once the session's list has a version other than `since`, or
     * with `since` itself after a wait of a few minutes with no change. A
     * session that is no bot's gets `None` at once: only a session's own
     * bridge, which knows its id, can hold a wait open.
     */
    readonly changes: (
      request: ToolChangesRequest,
    ) => Effect.Effect<Option.Option<ToolChangesResponse>>;
  }
>()("@j3-bots/server/tools/ToolLists") {}

export const layer = Layer.effect(
  ToolLists,
  Effect.gen(function* () {
    const sessions = yield* EngineSessions;
    const connectors = yield* Connectors;
    const bots = yield* BotStore;
    const process = yield* (yield* Ids).make("tools");
    const changes = yield* SubscriptionRef.make<ReadonlyMap<BotId, number>>(new Map());
    yield* Stream.merge(
      connectors.toolsChanged,
      (yield* browserSwitches).pipe(Stream.map(({ botId }) => botId)),
    ).pipe(
      Stream.runForEach((botId) =>
        SubscriptionRef.update(changes, (counts) =>
          new Map(counts).set(botId, (counts.get(botId) ?? 0) + 1),
        ),
      ),
      Effect.forkScoped,
    );

    const versionOf = (counts: ReadonlyMap<BotId, number>, botId: BotId) =>
      `${process}.${counts.get(botId) ?? 0}`;

    const list = Effect.fn("ToolLists.list")(function* (sessionId: SessionId) {
      const caller = yield* sessions.ofEngineSession(sessionId);
      // Not a session of a bot: every call it makes is refused anyway.
      if (Option.isNone(caller)) return { version: process, tools: ownTools };
      // Read before the tools, so a change made while they are read gives a
      // later version, and the bridge lists again.
      const version = versionOf(yield* SubscriptionRef.get(changes), caller.value.botId);
      const offered = yield* connectors.toolsFor(caller.value.botId);
      const skills = yield* connectors.skillsFor(caller.value.botId);
      // Only once the session's instructions carry the browser's rules, and
      // never after the switch is off, even before the session is reloaded.
      const browsing =
        caller.value.browser &&
        Option.exists(yield* bots.find(caller.value.botId), (stored) => stored.bot.browser);
      return {
        version,
        tools: [
          ...ownToolsWith(skills),
          ...(browsing ? browserTools : []),
          ...offered.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        ],
      };
    });

    const waitForChange = Effect.fn("ToolLists.changes")(function* (request: ToolChangesRequest) {
      const caller = yield* sessions.ofEngineSession(request.sessionId);
      if (Option.isNone(caller)) return Option.none();
      const botId = caller.value.botId;
      const changed = yield* SubscriptionRef.changes(changes).pipe(
        Stream.map((counts) => versionOf(counts, botId)),
        Stream.filter((version) => version !== request.since),
        Stream.runHead,
        Effect.timeoutOption(CHANGE_WAIT),
      );
      return Option.some({
        version: Option.getOrElse(Option.flatten(changed), () => request.since),
      });
    });

    return ToolLists.of({ list, changes: waitForChange });
  }),
);
