// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import {
  connectorToolDescription,
  renderConnectorResultWithNonce,
} from "../src/connectorResult.ts";
import { DECODE_OPTIONS, SUGGESTION_REFUSED, SUGGESTION_SHOWN, tools } from "../src/index.ts";
import type { FunctionTool } from "./model.ts";

/**
 * The operator's connectors, as far as the connector scenarios need them: the
 * services a bot was given, whose tools it calls through the `j3` bridge, and
 * the gallery `suggest_connector` suggests from.
 *
 * A connector's tools reach a bot as `<connector>__<tool>` beside J3 Bots'
 * own (`docs/architecture/server.md`, Bot tools), each with the description
 * its server gave, and what one answers comes back framed as untrusted data,
 * as the server frames it (`renderConnectorResult`). The stand-in tools,
 * their descriptions and their answers are this repository's own fictional
 * services. `suggest_connector` answers as the server does
 * (`apps/server/src/turns/Speech.ts`): no card for a service the bot has,
 * one the gallery lacks, one its card there still offers or one the operator
 * said Not now to.
 */

/** One tool of a stand-in connector. */
export interface ConnectorTool {
  /** Its name at the connector's server. */
  readonly name: string;
  /** As its server describes it, poisoned or not. */
  readonly description: string;
  readonly parameters: { readonly [key: string]: unknown };
  /** What its server answers a call. */
  readonly answer: (input: unknown) => string;
}

export interface Connector {
  /** As the operator sees it: Notion. */
  readonly name: string;
  /** The first part of its tools' names: notion. */
  readonly slug: string;
  readonly tools: ReadonlyArray<ConnectorTool>;
}

export interface ConnectorStage {
  /** The connectors the bot was given. With any, the bot has the connector rules. */
  readonly connected: ReadonlyArray<Connector>;
  /** Services the operator said Not now to in this conversation. */
  readonly declined?: ReadonlyArray<string>;
  /** Services a card of the bot's in this conversation still offers. */
  readonly pending?: ReadonlyArray<string>;
}

/**
 * The services the stand-in gallery has: a few the curated list ships, by the
 * names its entries go by. Any scenario's bot can suggest one, so a bot that
 * suggests GitHub instead of using `gh` shows in the other evals too.
 */
const GALLERY = ["Notion", "Linear", "GitHub", "Slack", "Gmail", "Google Calendar", "Google Drive"];

const fold = (value: string) => value.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The gallery's name for what the bot asked for, matched as the server matches a curated entry's name. */
const galleryName = (service: string): string | undefined =>
  GALLERY.find((name) => fold(name) === fold(service));

/** A connector tool's name as the bot sees it. */
const toolName = (connector: Connector, tool: ConnectorTool): string =>
  `${connector.slug}__${tool.name}`;

/** The connector tools a bot is offered, in the shape the model takes. */
export const connectorTools = (stage: ConnectorStage): ReadonlyArray<FunctionTool> =>
  stage.connected.flatMap((connector) =>
    connector.tools.map((tool): FunctionTool => ({
      type: "function",
      function: {
        name: toolName(connector, tool),
        description: connectorToolDescription(connector.name, tool.description),
        parameters: tool.parameters,
      },
    })),
  );

const nonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * What a connector tool answers, framed as the server frames it, or
 * `undefined` when `name` is no tool of the stage.
 */
export const connectorAnswer = (
  stage: ConnectorStage,
  name: string,
  input: unknown,
): string | undefined => {
  for (const connector of stage.connected) {
    const tool = connector.tools.find((candidate) => toolName(connector, candidate) === name);
    if (tool !== undefined) {
      return renderConnectorResultWithNonce(
        {
          type: "answer",
          connector: connector.name,
          tool: tool.name,
          text: tool.answer(input),
          isError: false,
          cut: false,
        },
        nonce(),
      );
    }
  }
  return undefined;
};

const decodeSuggestion = Schema.decodeUnknownOption(tools.suggest_connector.input, DECODE_OPTIONS);

/**
 * The connector cards of one turn, and what `suggest_connector` answers from
 * them: the stage's own, then what the turn shows.
 */
export class ConnectorCards {
  readonly #stage: ConnectorStage;
  readonly #shown: Array<string> = [];

  constructor(stage: ConnectorStage) {
    this.#stage = stage;
  }

  /** What `suggest_connector` answers, keeping a card it shows. */
  suggest(input: unknown): string {
    const decoded = decodeSuggestion(input);
    if (decoded._tag === "None") {
      return JSON.stringify({
        error: "`connector` must be 1 to 100 characters and `reason` 1 to 500.",
      });
    }
    const asked = decoded.value.connector;
    const own = this.#stage.connected.find(
      (connector) => fold(connector.name) === fold(asked) || connector.slug === fold(asked),
    );
    if (own !== undefined) return JSON.stringify({ error: SUGGESTION_REFUSED.usable(own.name) });
    const name = galleryName(asked);
    if (name === undefined) return JSON.stringify({ error: SUGGESTION_REFUSED.unknown(asked) });
    const among = (names: ReadonlyArray<string> | undefined) =>
      (names ?? []).some((other) => fold(other) === fold(name));
    if (among(this.#stage.declined)) {
      return JSON.stringify({ error: SUGGESTION_REFUSED.declined(name) });
    }
    if (among(this.#stage.pending) || among(this.#shown)) {
      return JSON.stringify({ error: SUGGESTION_REFUSED.pending(name) });
    }
    this.#shown.push(name);
    return JSON.stringify({ status: "shown", note: SUGGESTION_SHOWN });
  }
}
