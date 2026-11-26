// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotId,
  Connector,
  ConnectorGlyph,
  ConnectorGrant,
  ConnectorId,
  ConnectorListing,
  ListingRef,
} from "@j3-bots/contracts";

/**
 * The operator's connectors once `upsert` and `remove` are applied: each
 * once, those already held where they were, new ones after them.
 */
export const applyConnectorChange = (
  current: ReadonlyArray<Connector>,
  upsert: ReadonlyArray<Connector>,
  remove: ReadonlyArray<ConnectorId>,
): ReadonlyArray<Connector> => {
  const gone = new Set<ConnectorId>(remove);
  const fresh = new Map(upsert.map((connector) => [connector.id, connector]));
  const kept = current
    .filter((connector) => !gone.has(connector.id))
    .map((connector) => fresh.get(connector.id) ?? connector);
  const known = new Set(kept.map((connector) => connector.id));
  return [
    ...kept,
    ...upsert.filter((connector) => !known.has(connector.id) && !gone.has(connector.id)),
  ];
};

/** Whether `grant` lets `botId` use the connector. */
export const grantsBot = (grant: ConnectorGrant, botId: BotId): boolean =>
  grant._tag === "all-bots" || grant.ids.includes(botId);

/** The connectors `botId` may use, in the order the server lists them. */
export const connectorsOf = (
  connectors: ReadonlyArray<Connector>,
  botId: BotId,
): ReadonlyArray<Connector> => connectors.filter((connector) => grantsBot(connector.grant, botId));

/**
 * Who a new connector is for until the operator says otherwise: the bot whose
 * details it is added from, else every bot, as the server would grant it.
 */
export const initialGrant = (bots: ReadonlyArray<Bot>, asking: BotId | null): ConnectorGrant => {
  const bot = asking === null ? undefined : bots.find((candidate) => candidate.id === asking);
  return bot === undefined ? { _tag: "all-bots" } : { _tag: "bots", ids: [bot.id] };
};

/**
 * `grant` with `botId` let in or taken out. Taking one bot out of "all bots"
 * leaves every other bot there is now: bots made later are no longer included.
 */
export const withBot = (
  grant: ConnectorGrant,
  botId: BotId,
  allowed: boolean,
  bots: ReadonlyArray<Bot>,
): ConnectorGrant => {
  const ids = grant._tag === "all-bots" ? bots.map((bot) => bot.id) : grant.ids;
  const without = ids.filter((id) => id !== botId);
  return { _tag: "bots", ids: allowed ? [...without, botId] : without };
};

/** Whether two grants let the same bots in. */
export const sameGrant = (a: ConnectorGrant, b: ConnectorGrant): boolean =>
  a._tag === "all-bots"
    ? b._tag === "all-bots"
    : b._tag === "bots" && a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id));

/**
 * What a connector's status light says: it works (`connected`), it waits on
 * the operator, for a sign-in or their secrets (`needs-you`), or it cannot be
 * reached (`failing`).
 */
export type ConnectorTone = "connected" | "needs-you" | "failing";

export const connectorTone = (connector: Connector): ConnectorTone => {
  switch (connector.status._tag) {
    case "connected":
      return "connected";
    case "needs-sign-in":
    case "secrets-unavailable":
      return "needs-you";
    case "failing":
      return "failing";
  }
};

/**
 * Whether the connector's tool changes wait on the operator's first answer. A
 * review they answered "not now" stays held, but no longer asks for them.
 */
export const awaitsReview = (connector: Connector): boolean =>
  connector.review !== null && !connector.review.kept;

/** Whether the operator has something to do for the connector: sign in, open Secrets, or review its tools. */
export const connectorNeedsYou = (connector: Connector): boolean =>
  connectorTone(connector) === "needs-you" || awaitsReview(connector);

/** The connector the operator added from `listing`, if they did. */
export const addedFrom = (
  connectors: ReadonlyArray<Connector>,
  listing: ConnectorListing["ref"],
): Connector | undefined =>
  connectors.find(
    (connector) =>
      connector.listing !== null &&
      (connector.listing._tag === "curated"
        ? listing._tag === "curated" && listing.key === connector.listing.key
        : listing._tag === "registry" && listing.name === connector.listing.name),
  );

/** A gallery entry's key, for lists and for what a screen shows. */
export const listingKey = (ref: ConnectorListing["ref"]): string =>
  ref._tag === "curated" ? `curated:${ref.key}` : `registry:${ref.name}`;

/**
 * Why a sign-in did not finish:
 * - `start-failed`: it did not start, or the server did not answer;
 * - `no-relay`: this device could not listen for the browser's return;
 * - `unsupported`: the service does not sign in as J3 Bots requires;
 * - `registration-refused`: the service did not let J3 Bots register;
 * - `unreachable`: the service did not answer while J3 Bots signed in;
 * - `refused`: the service refused the sign-in, or what came back;
 * - `expired`: the sign-in's time ran out;
 * - `secrets-unavailable`: the secrets, which keep the sign-in, cannot be read;
 * - `not-paired`: this device lost its pairing.
 */
export type SignInProblem =
  | "start-failed"
  | "no-relay"
  | "unsupported"
  | "registration-refused"
  | "unreachable"
  | "refused"
  | "expired"
  | "secrets-unavailable"
  | "not-paired";

/** A page of the connectors screen. */
export type ConnectorsPlace =
  | { readonly _tag: "home" }
  | {
      readonly _tag: "listing";
      readonly ref: ListingRef;
      /** Its name and glyph, shown while its page loads. */
      readonly name: string;
      readonly glyph: ConnectorGlyph | null;
    }
  | {
      readonly _tag: "connector";
      readonly connectorId: ConnectorId;
      /** Start its sign-in as the page opens, as a card's Sign in asks. */
      readonly signIn: boolean;
      /** It was just added here: the page says who can use it from now. */
      readonly added: boolean;
    }
  | { readonly _tag: "add-own" };

/**
 * What opens the connectors screen: where it opens, and the bot a new
 * connector is for at first (the one whose details opened it; null for
 * every bot).
 */
export interface ConnectorsOpening {
  readonly at: ConnectorsPlace;
  readonly forBot: BotId | null;
}

/** The page a connector just added opens on: its sign-in started, when it has one to do. */
export const addedPlace = (connector: Connector): ConnectorsPlace => ({
  _tag: "connector",
  connectorId: connector.id,
  signIn: connector.signIn === "oauth" && connector.status._tag === "needs-sign-in",
  added: true,
});

/** The page a gallery entry opens: the connector added from it, if any, else its own. */
export const listingPlace = (
  connectors: ReadonlyArray<Connector>,
  listing: Pick<ConnectorListing, "ref" | "name" | "glyph">,
): ConnectorsPlace => {
  const added = addedFrom(connectors, listing.ref);
  return added === undefined
    ? { _tag: "listing", ref: listing.ref, name: listing.name, glyph: listing.glyph }
    : { _tag: "connector", connectorId: added.id, signIn: false, added: false };
};
