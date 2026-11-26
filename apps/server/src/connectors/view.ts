// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CatalogTool,
  type Failing,
  type Prompt,
  type Resource,
  type ServerInfo,
  type SignInNeed,
  statusOf,
} from "@j3-bots/connectors";
import {
  type Connector,
  type ConnectorServer,
  ConnectorToolName,
  type ConnectorTool,
  type ConnectorStatus,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import type { SignInState } from "./auth.ts";
import type { StoredConnector } from "./ConnectorStore.ts";

/**
 * A connector as the operator and its bots see it, from what is stored and
 * what this server saw of it since it started.
 */

/** What this server saw of a connector since it started. */
export interface Seen {
  /** What its server listed last; none until a session listed its tools. */
  readonly listed: Option.Option<ReadonlyArray<CatalogTool>>;
  /** What its server said of itself, and the resources and prompts it listed last. */
  readonly served: Option.Option<Served>;
  readonly failing: Option.Option<Failing>;
  /** Its server refused the credentials it was sent, and nothing has worked since. */
  readonly refused: boolean;
}

interface Served {
  readonly info: ServerInfo;
  readonly resources: ReadonlyArray<Resource>;
  readonly prompts: ReadonlyArray<Prompt>;
}

export const NOTHING_SEEN: Seen = {
  listed: Option.none(),
  served: Option.none(),
  failing: Option.none(),
  refused: false,
};

/**
 * The tools bots get: what its server listed last. Until it lists them again
 * after a restart, those it listed before; a call opens a session, which
 * lists them, before it goes out.
 */
export const offeredOf = (connector: StoredConnector, seen: Seen): ReadonlyArray<CatalogTool> =>
  Option.getOrElse(seen.listed, () => connector.tools ?? []);

const toolOf = (tool: CatalogTool): ConnectorTool => ({
  name: ConnectorToolName.make(tool.name),
  title: tool.title,
  description: tool.description,
});

/** What the operator sees of the connector's server. Its name and version are cleaned titles already. */
const serverOf = (connector: StoredConnector, seen: Seen): ConnectorServer | null =>
  Option.match(seen.served, {
    onNone: () => null,
    onSome: ({ info, resources, prompts }) => ({
      protocolVersion: info.protocolVersion.slice(0, 32),
      name: info.name,
      version: info.version,
      tools: offeredOf(connector, seen).length,
      resources: resources.length,
      prompts: prompts.length,
    }),
  });

const signInNeedOf = (
  connector: StoredConnector,
  seen: Seen,
  signIn: Option.Option<SignInState>,
): Option.Option<SignInNeed> => {
  if (seen.refused) return Option.some("rejected");
  switch (connector.signIn) {
    case "none":
      return Option.none();
    case "fields":
      return connector.signedInAt === null ? Option.some("not-signed-in") : Option.none();
    case "oauth":
      return Option.match(signIn, {
        onNone: () => Option.some("not-signed-in"),
        onSome: (state) =>
          state._tag === "needs-sign-in" ? Option.some(state.reason) : Option.none(),
      });
  }
};

/** The connector's status, as the operator sees it: a bot is offered its tools only while it is connected. */
export const statusOfConnector = (
  connector: StoredConnector,
  seen: Seen,
  secretsUnavailable: boolean,
  signIn: Option.Option<SignInState>,
): ConnectorStatus =>
  statusOf({
    secretsUnavailable:
      secretsUnavailable || Option.exists(signIn, (state) => state._tag === "secrets-unavailable"),
    signIn: signInNeedOf(connector, seen, signIn),
    failing: seen.failing,
  });

export const connectorOf = (
  connector: StoredConnector,
  seen: Seen,
  secretsUnavailable: boolean,
  signIn: Option.Option<SignInState>,
): Connector => {
  const signedIn = Option.filter(signIn, (state) => state._tag === "signed-in");
  return {
    id: connector.id,
    name: connector.name,
    glyph: connector.glyph,
    publisher: connector.publisher,
    listing: connector.listing,
    transport: connector.transport,
    signIn: connector.signIn,
    fields: connector.fields,
    status: statusOfConnector(connector, seen, secretsUnavailable, signIn),
    grant: connector.grant,
    account: Option.match(signedIn, {
      onNone: () => null,
      onSome: (state) => (state._tag === "signed-in" ? state.account : null),
    }),
    signedInAt:
      connector.signIn === "oauth"
        ? Option.match(signedIn, {
            onNone: () => null,
            onSome: (state) => (state._tag === "signed-in" ? state.signedInAt : null),
          })
        : connector.signedInAt,
    tools: offeredOf(connector, seen).map(toolOf),
    server: serverOf(connector, seen),
    createdAt: connector.createdAt,
    lastChange: connector.lastChange,
  };
};
