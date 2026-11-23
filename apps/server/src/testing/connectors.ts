// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  Connectors,
  type OfferedTool,
  type ToolCallAnswer,
  ToolNotOffered,
} from "../connectors/Connectors.ts";

/** A call that reached a connector: for which bot, to which tool, with what. */
export interface ConnectorCall {
  readonly botId: BotId;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * How the connectors answer a call to a tool the bot is offered. The default
 * answers with the tool's name.
 */
export type ConnectorAnswerer = (call: ConnectorCall) => Effect.Effect<ToolCallAnswer>;

/** In-memory connectors, whose offered tools and answers a test sets. */
export class TestConnectors extends Context.Service<
  TestConnectors,
  {
    /** `botId` is offered these tools from now on, and its list changes. */
    readonly offer: (botId: BotId, tools: ReadonlyArray<OfferedTool>) => Effect.Effect<void>;
    readonly answerWith: (answerer: ConnectorAnswerer) => Effect.Effect<void>;
    /** Every call that reached a connector, in order. */
    readonly calls: Effect.Effect<ReadonlyArray<ConnectorCall>>;
  }
>()("@j3-bots/server/testing/connectors/TestConnectors") {}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const offered = yield* Ref.make<ReadonlyMap<BotId, ReadonlyArray<OfferedTool>>>(new Map());
    const answerer = yield* Ref.make<ConnectorAnswerer>((call) =>
      Effect.succeed({ text: `${call.name} answered`, isError: false }),
    );
    const calls = yield* Ref.make<ReadonlyArray<ConnectorCall>>([]);
    const changes = yield* PubSub.unbounded<BotId>();

    const toolsFor = (botId: BotId) =>
      Ref.get(offered).pipe(Effect.map((tools) => tools.get(botId) ?? []));

    const connectors = Connectors.of({
      toolsFor,
      toolsChanged: Stream.fromPubSub(changes),
      call: (input) =>
        Effect.gen(function* () {
          const tools = yield* toolsFor(input.botId);
          if (!tools.some((tool) => tool.name === input.name)) {
            return yield* new ToolNotOffered();
          }
          yield* Ref.update(calls, (made) => [...made, input]);
          return yield* (yield* Ref.get(answerer))(input);
        }),
    });

    const control = TestConnectors.of({
      offer: (botId, tools) =>
        Ref.update(offered, (current) => new Map(current).set(botId, tools)).pipe(
          Effect.andThen(PubSub.publish(changes, botId)),
          Effect.asVoid,
        ),
      answerWith: (next) => Ref.set(answerer, next),
      calls: Ref.get(calls),
    });

    return Context.make(Connectors, connectors).pipe(Context.add(TestConnectors, control));
  }),
);
