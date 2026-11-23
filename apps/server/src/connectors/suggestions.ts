// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorSuggestionEntry, ListingRef } from "@j3-bots/contracts";
import type { StoredConnector } from "./ConnectorStore.ts";

/**
 * Which service a `connector-suggestion` card offers: what a new suggestion is
 * refused against, and which cards close when their bot gets the connector.
 */

/** Text folded for matching a service's name: lower case, without accents or surrounding spaces. */
export const fold = (value: string) =>
  value.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export const sameListing = (a: ListingRef, b: ListingRef) =>
  a._tag === "curated"
    ? b._tag === "curated" && a.key === b.key
    : b._tag === "registry" && a.name === b.name;

/**
 * The service a card offers, or a suggestion would: by its subject, its name
 * and the gallery entries that connect it, if any.
 */
export interface OfferedService {
  readonly subject: ConnectorSuggestionEntry["subject"];
  readonly name: string;
  readonly listings: ReadonlyArray<ListingRef>;
}

/**
 * Whether a card offers `service`: the same connector, a gallery entry that
 * connects the same service, or the same name. A card that named one of the operator's
 * connectors keeps only that connector and its name, so a suggestion of the
 * entry it was added from matches it only by name.
 */
export const offers = (card: ConnectorSuggestionEntry, service: OfferedService) => {
  if (fold(card.name) === fold(service.name)) return true;
  if (card.subject._tag === "connector") {
    return (
      service.subject._tag === "connector" &&
      card.subject.connectorId === service.subject.connectorId
    );
  }
  const { ref } = card.subject;
  return service.listings.some((listing) => sameListing(ref, listing));
};

/** The service one of the operator's connectors is. */
export const serviceOf = (connector: StoredConnector): OfferedService => ({
  subject: { _tag: "connector", connectorId: connector.id },
  name: connector.name,
  listings: connector.listing === null ? [] : [connector.listing],
});
