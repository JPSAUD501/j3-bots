// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CatalogTool,
  compareCatalog,
  type Failing,
  type SignInNeed,
  statusOf,
} from "@j3-bots/connectors";
import {
  type Connector,
  ConnectorToolName,
  type ConnectorTool,
  type ConnectorStatus,
  type HeldToolChange,
  type ToolReview,
  ToolReviewRevision,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import type { SignInState } from "./auth.ts";
import type { StoredConnector } from "./ConnectorStore.ts";
import { usesVault } from "./credentials.ts";

/**
 * A connector as the operator and its bots see it, from what is stored and
 * what this server saw of it since it started.
 */

/** What this server saw of a connector since it started. */
export interface Seen {
  /** What its server listed last; none until a session listed its tools. */
  readonly listed: Option.Option<ReadonlyArray<CatalogTool>>;
  readonly failing: Option.Option<Failing>;
  /** Its server refused the credentials it was sent, and nothing has worked since. */
  readonly refused: boolean;
}

export const NOTHING_SEEN: Seen = { listed: Option.none(), failing: Option.none(), refused: false };

/**
 * The tools bots get: the accepted ones whose listing still matches. Until
 * its server lists them again after a restart, the accepted ones as they
 * are; a call opens a session, which lists them, before it goes out.
 */
export const offeredOf = (connector: StoredConnector, seen: Seen): ReadonlyArray<CatalogTool> => {
  const accepted = connector.accepted ?? [];
  return Option.match(seen.listed, {
    onNone: () => accepted,
    onSome: (listed) => compareCatalog(accepted, listed).offered,
  });
};

const toolOf = (tool: CatalogTool): ConnectorTool => ({
  name: ConnectorToolName.make(tool.name),
  title: tool.title,
  description: tool.description,
});

/** The changes held for the operator, as the connector's page shows them; null when none are. */
const reviewOf = (connector: StoredConnector, seen: Seen): ToolReview | null => {
  if (connector.accepted === null || Option.isNone(seen.listed)) return null;
  const state = compareCatalog(connector.accepted, seen.listed.value);
  const changes = state.held.map((held): HeldToolChange =>
    held.change === "added"
      ? { _tag: "added", tool: toolOf(held.tool) }
      : {
          _tag: "changed",
          tool: toolOf(held.tool),
          previous: toolOf(held.previous),
          inputChanged: held.inputChanged,
        },
  );
  const [first, ...rest] = changes;
  if (first === undefined) return null;
  return {
    revision: ToolReviewRevision.make(state.revision),
    changes: [first, ...rest],
    kept: connector.keptRevision === state.revision,
  };
};

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

const statusOfConnector = (
  connector: StoredConnector,
  seen: Seen,
  vaultLocked: boolean,
  signIn: Option.Option<SignInState>,
): ConnectorStatus =>
  statusOf({
    vaultLocked:
      (usesVault(connector) && vaultLocked) ||
      Option.exists(signIn, (state) => state._tag === "vault-locked"),
    signIn: signInNeedOf(connector, seen, signIn),
    failing: seen.failing,
  });

export const connectorOf = (
  connector: StoredConnector,
  seen: Seen,
  vaultLocked: boolean,
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
    status: statusOfConnector(connector, seen, vaultLocked, signIn),
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
    review: reviewOf(connector, seen),
    createdAt: connector.createdAt,
  };
};
