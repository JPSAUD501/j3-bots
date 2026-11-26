// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorListingDetails, ConnectorSetup } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";

/**
 * The client of the app the operator registered at a service, as their yes to
 * a bot's ask to add a gallery entry that signs in with it carries it. The
 * secret travels redacted, and only to the server.
 */
export interface OwnAppClient {
  readonly clientId: string;
  /** Null for an app the service registers without one. */
  readonly clientSecret: Redacted.Redacted<string> | null;
}

/**
 * What the card shows the operator to set their app up: the entry's steps,
 * the page they start at, and the address its sign-ins return to, which they
 * register on the app.
 */
export interface OwnAppSetup {
  readonly steps: ReadonlyArray<string>;
  readonly url: ConnectorSetup["url"];
  readonly redirect: string | null;
}

/**
 * `listing`'s setup, with the return address this device's sign-ins take:
 * the server's own when the browser returns to it (`returnsToServer`), this
 * device's loopback otherwise.
 */
export const ownAppSetup = (
  listing: ConnectorListingDetails,
  returnsToServer: boolean,
): OwnAppSetup => ({
  steps: listing.setup?.steps ?? [],
  url: listing.setup?.url ?? null,
  redirect:
    listing.redirects === null
      ? null
      : returnsToServer
        ? listing.redirects.server
        : listing.redirects.loopback,
});

const MAX_CLIENT_ID = 500;
const MAX_CLIENT_SECRET = 2_000;

/**
 * The client as the operator typed it, or which field the server would
 * refuse: an ID is required, and a secret, when given, is one line.
 */
export const ownAppClient = (
  clientId: string,
  clientSecret: string,
):
  | { readonly _tag: "valid"; readonly client: OwnAppClient }
  | { readonly _tag: "invalid"; readonly problem: "client-id" | "client-secret" } => {
  const id = clientId.trim();
  if (id === "" || id.length > MAX_CLIENT_ID) return { _tag: "invalid", problem: "client-id" };
  if (clientSecret === "") {
    return { _tag: "valid", client: { clientId: id, clientSecret: null } };
  }
  if (clientSecret.length > MAX_CLIENT_SECRET || /[\r\n\0]/.test(clientSecret)) {
    return { _tag: "invalid", problem: "client-secret" };
  }
  return { _tag: "valid", client: { clientId: id, clientSecret: Redacted.make(clientSecret) } };
};
