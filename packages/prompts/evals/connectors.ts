// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import {
  connectorToolDescription,
  renderConnectorResultWithNonce,
} from "../src/connectorResult.ts";
import { DECODE_OPTIONS, MANAGEMENT_NOTES, tools } from "../src/index.ts";
import type { FunctionTool } from "./model.ts";

/**
 * The operator's connectors, as far as the connector scenarios need them: the
 * services a bot was given, whose tools it calls through the `j3` bridge, and
 * the gallery `search_mcp_servers` searches and `add_mcp_server` adds from.
 *
 * A connector's tools reach a bot as `<connector>__<tool>` beside J3 Bots'
 * own (`docs/architecture/server.md`, Bot tools), each with the description
 * its server gave, and what one answers comes back framed as untrusted data,
 * as the server frames it (`renderConnectorResult`). The stand-in tools,
 * their descriptions and their answers are this repository's own fictional
 * services. The MCP server tools answer as the server does
 * (`apps/server/src/tools/Management.ts`), in its shape: a gallery entry that
 * signs in is added waiting on its sign-in, one added by address connects.
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
}

/**
 * The services the stand-in gallery has: a few the curated list ships, by the
 * names and keys its entries go by, each signing in. Any scenario's bot can
 * add one, so a bot that adds GitHub instead of using `gh` shows in the other
 * evals too.
 */
const GALLERY = [
  { name: "Notion", key: "notion" },
  { name: "Linear", key: "linear" },
  { name: "GitHub", key: "github" },
  { name: "Slack", key: "slack" },
  { name: "Google Calendar", key: "google-calendar" },
  { name: "Google Drive", key: "google-drive" },
];

const fold = (value: string) => value.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

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

const decodeAdd = Schema.decodeUnknownOption(tools.add_mcp_server.input, DECODE_OPTIONS);
const decodeSearch = Schema.decodeUnknownOption(tools.search_mcp_servers.input, DECODE_OPTIONS);

const refused = (reason: string) => JSON.stringify({ error: reason });

/**
 * The operator's MCP servers over one turn, as the MCP server tools see and
 * change them: the stage's, then what the turn adds, each for the calling bot.
 */
export class McpServers {
  readonly #stage: ConnectorStage;
  readonly #added: Array<{ readonly id: string; readonly name: string; readonly status: string }> =
    [];

  constructor(stage: ConnectorStage) {
    this.#stage = stage;
  }

  /** What `search_mcp_servers` answers: the gallery's entries whose name has the query in it. */
  search(input: unknown): string {
    const decoded = decodeSearch(input);
    if (decoded._tag === "None") return refused("`query` must be 1 to 100 characters.");
    const query = fold(decoded.value.query);
    const servers = GALLERY.filter(
      (entry) => fold(entry.name).includes(query) || query.includes(fold(entry.name)),
    ).map((entry) => ({
      id: `curated:${entry.key}`,
      name: entry.name,
      summary: `${entry.name}, from its maker.`,
      from: `${entry.key}.example`,
      connects: "sign-in",
      fields: [],
    }));
    return JSON.stringify({ servers, registry: "answered" });
  }

  /** What `list_mcp_servers` answers. */
  list(): string {
    return JSON.stringify({
      servers: [
        ...this.#stage.connected.map((connector) => ({
          id: `conn_${connector.slug}`,
          name: connector.name,
          prefix: connector.slug,
          status: "connected",
          bots: "every-bot",
          mayChange: false,
          lastChange: null,
        })),
        ...this.#added.map((server) => ({
          ...server,
          prefix: fold(server.name).replace(/[^a-z0-9]+/g, "_"),
          bots: ["this-bot"],
          mayChange: true,
          lastChange: { by: { bot: "you" }, at: "now" },
        })),
      ],
    });
  }

  /** What `add_mcp_server` answers, keeping the server it adds. */
  add(input: unknown): string {
    const decoded = decodeAdd(input);
    if (decoded._tag === "None") {
      return refused(
        "Give exactly one of gallery, url and command, with a name for url or command.",
      );
    }
    const { gallery, url, name } = decoded.value;
    const entry =
      gallery === undefined ? undefined : GALLERY.find(({ key }) => gallery === `curated:${key}`);
    if (gallery !== undefined && entry === undefined) {
      return refused(`${gallery} is no entry of the gallery. Search for it first.`);
    }
    const server = {
      id: `conn_${this.#added.length + 1}`,
      name: entry?.name ?? name ?? url ?? "Server",
      status: entry === undefined ? "connected" : "needs-sign-in",
    };
    this.#added.push(server);
    return JSON.stringify({
      server: {
        id: server.id,
        name: server.name,
        status: entry === undefined ? "connected" : { needsSignIn: "new" },
      },
      note: entry === undefined ? MANAGEMENT_NOTES.connected : MANAGEMENT_NOTES.signInPending,
    });
  }
}
