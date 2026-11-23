// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  CommandError,
  CommandId,
  Connector,
  ConnectorFieldValue,
  ConnectorGrant,
  ConnectorId,
  ConnectorSource,
  EntryId,
  ToolReviewRevision,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/**
 * The operator's connectors (`docs/architecture/server.md`, "Connectors"):
 * what the connector requests do, the tools each bot is offered, and the
 * calls bots make to them.
 */

/** A connector's tool as a bot is offered it, through the `j3` bridge. */
export interface OfferedTool {
  /** `<slug>__<tool>`: at most 55 characters of `[A-Za-z0-9_-]`, with exactly one `__`. */
  readonly name: string;
  readonly connectorId: ConnectorId;
  /** Its name at the connector's server. */
  readonly upstreamName: string;
  /** Cleaned and capped, as the operator accepted it. */
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
}

/** What a bot reads back from a connector's tool: framed as untrusted data, or J3 Bots' own line when there was no answer. */
export interface ToolCallAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** The bot is offered no tool by that name: no such connector tool, not granted, or not accepted. */
export class ToolNotOffered extends Schema.TaggedError<ToolNotOffered>()("ToolNotOffered", {}) {
  override get message(): string {
    return "No connector tool by that name is offered to this bot.";
  }
}

/** What `connectors.subscribe` sends. */
export type ConnectorsEvent =
  | { readonly _tag: "snapshot"; readonly connectors: ReadonlyArray<Connector> }
  | {
      readonly _tag: "changed";
      readonly upsert: ReadonlyArray<Connector>;
      readonly remove: ReadonlyArray<ConnectorId>;
    };

export class Connectors extends Context.Service<
  Connectors,
  {
    /** The tools `botId` is offered now: granted, signed-in connectors' accepted tools. */
    readonly toolsFor: (botId: BotId) => Effect.Effect<ReadonlyArray<OfferedTool>>;
    /** Each bot whose offered tools may have changed, from the moment of subscribing. */
    readonly toolsChanged: Stream.Stream<BotId>;
    /**
     * Calls the tool for `botId`. A connector that can't answer gives the
     * bot J3 Bots' own line, as an error result, not a failure.
     * Interrupting the call cancels it at the connector's server.
     */
    readonly call: (input: {
      readonly botId: BotId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    readonly subscribe: Stream.Stream<ConnectorsEvent>;
    readonly add: (input: {
      readonly id: ConnectorId;
      readonly source: ConnectorSource;
      readonly grant?: ConnectorGrant;
      readonly suggestion: EntryId | null;
    }) => Effect.Effect<Connector, CommandError>;
    readonly update: (input: {
      readonly connectorId: ConnectorId;
      readonly name?: string;
      readonly values?: ReadonlyArray<ConnectorFieldValue>;
    }) => Effect.Effect<Connector, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
    }) => Effect.Effect<void, CommandError>;
    readonly setBots: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly grant: ConnectorGrant;
    }) => Effect.Effect<Connector, CommandError>;
    readonly acceptToolChanges: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly revision: ToolReviewRevision;
      readonly decision: "accept" | "keep";
    }) => Effect.Effect<Connector, CommandError>;
  }
>()("@j3-bots/server/connectors/Connectors") {}
