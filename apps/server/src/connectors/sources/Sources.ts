// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  type ConnectKind,
  type ConnectorField,
  type ConnectorListing,
  type ConnectorListingDetails,
  Invalid,
  type Language,
  type ListingRef,
  MAX_CONNECTOR_SUMMARY_LENGTH,
  NotFound,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  CURATED,
  curatedAuthorization,
  curatedCovers,
  curatedDetails,
  curatedEntry,
  curatedForm,
  curatedListing,
  curatedMatches,
  NO_AUTHORIZATION,
} from "./Curated.ts";
import { type ConnectForm, contractFields, plainText } from "./form.ts";
import type { AuthorizationExtras } from "../oauth/ConnectorAuth.ts";
import { McpRegistry, type RegistryEntry } from "./Registry.ts";

// Where the connector gallery's entries come from: J3 Bots' curated list,
// shipped with the server, and the official MCP Registry, searched through
// the server. A curated entry always comes first, in J3 Bots' own words; the
// registry fills the rest with its publishers' words, cut short and marked as
// theirs.

/** How a registry entry connects, from what its form asks for. */
const registryConnectKind = (form: ConnectForm | null): ConnectKind => {
  if (form === null) return "unsupported";
  // A secret field is a token or a key. Without one, nearly every remote
  // server signs in through the browser; one that turns out to need nothing
  // connects without it.
  return form.fields.some((field) => field.secret) ? "token" : "sign-in";
};

const registryListing = (entry: RegistryEntry): ConnectorListing => ({
  ref: { _tag: "registry", name: entry.name },
  name: entry.title,
  summary: plainText(entry.description ?? undefined, MAX_CONNECTOR_SUMMARY_LENGTH) ?? "",
  glyph: null,
  publisher:
    entry.owner === null
      ? { _tag: "community", namespace: entry.name.slice(0, entry.name.indexOf("/")) }
      : { _tag: "domain", domain: entry.owner },
  connect: registryConnectKind(entry.form),
});

const registryDetails = (entry: RegistryEntry): ConnectorListingDetails => ({
  ...registryListing(entry),
  description: entry.description ?? "",
  fields: entry.form === null ? [] : contractFields(entry.form),
  setup: null,
  command: null,
  tools: null,
});

/** Whether a client offers the listing by default: one J3 Bots connects from any client. */
const connectableAnywhere = (listing: ConnectorListing) =>
  listing.connect !== "unsupported" && listing.connect !== "command";

/**
 * What adding a listing needs to know of it: its form, which turns the values
 * the operator gave into the address and headers to send, and that form's
 * fields as the operator reads them, in their language.
 */
export interface ListingConnection {
  readonly listing: ConnectorListing;
  readonly form: ConnectForm;
  /** One for each of the form's fields, under the same key. */
  readonly fields: ReadonlyArray<ConnectorField>;
}

export class ConnectorSources extends Context.Service<
  ConnectorSources,
  {
    /** The curated list, in `language`: what the gallery features. */
    readonly list: (language: Language) => ReadonlyArray<ConnectorListing>;
    /**
     * The curated entries that match `query`, then the registry's, best
     * first, without the registry's entries the curated list already has.
     * Without `all`, only listings any client can connect. When the registry
     * does not answer in time, the curated matches come alone.
     */
    readonly search: (input: {
      readonly query: string;
      readonly language: Language;
      readonly all: boolean;
    }) => Effect.Effect<{
      readonly listings: ReadonlyArray<ConnectorListing>;
      readonly registry: "answered" | "unavailable";
    }>;
    /** One listing's page. */
    readonly get: (
      ref: ListingRef,
      language: Language,
    ) => Effect.Effect<ConnectorListingDetails, NotFound | Conflict>;
    /** What adding the listing `ref` needs: its form, and its fields in `language`. */
    readonly connection: (
      ref: ListingRef,
      language: Language,
    ) => Effect.Effect<ListingConnection, NotFound | Conflict | Invalid>;
    /**
     * What a sign-in to a connector added from `ref` adds to its
     * authorization request: an own-app entry's scopes and its app's
     * parameters. Read from the list this release ships, so a sign-in after
     * an update asks for what the list says then.
     */
    readonly authorization: (ref: ListingRef) => AuthorizationExtras;
  }
>()("@j3-bots/server/connectors/sources/Sources/ConnectorSources") {}

const unavailable = () => Effect.fail(new Conflict({ reason: "registry-unavailable" }));

export const layer = Layer.effect(
  ConnectorSources,
  Effect.gen(function* () {
    const registry = yield* McpRegistry;
    const list = CURATED;

    const registryEntry = (name: Extract<ListingRef, { readonly _tag: "registry" }>) =>
      registry.get(name.name).pipe(
        Effect.catchTag("RegistryUnavailable", unavailable),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ resource: "connector-listing" })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const curated = (key: string) => {
      const entry = curatedEntry(list, key);
      return entry === undefined
        ? Effect.fail(new NotFound({ resource: "connector-listing" }))
        : Effect.succeed(entry);
    };

    return ConnectorSources.of({
      list: (language) => list.connectors.map((entry) => curatedListing(entry, language)),

      search: Effect.fn("ConnectorSources.search")(function* ({ query, language, all }) {
        const fromList = list.connectors
          .filter((entry) => curatedMatches(list, entry, query))
          .map((entry) => curatedListing(entry, language));
        const answered = yield* registry.search(query).pipe(Effect.result);
        const fromRegistry = Result.isSuccess(answered)
          ? answered.success
              .filter(
                (entry) =>
                  !curatedCovers(
                    list,
                    entry.name,
                    entry.form === null ? [] : [entry.form.urlTemplate],
                  ),
              )
              .map(registryListing)
          : [];
        const listings = [...fromList, ...fromRegistry];
        return {
          listings: all ? listings : listings.filter(connectableAnywhere),
          registry: Result.isSuccess(answered) ? "answered" : "unavailable",
        } as const;
      }),

      get: Effect.fn("ConnectorSources.get")(function* (ref, language) {
        if (ref._tag === "curated") return curatedDetails(list, yield* curated(ref.key), language);
        return registryDetails(yield* registryEntry(ref));
      }),

      connection: Effect.fn("ConnectorSources.connection")(function* (ref, language) {
        if (ref._tag === "curated") {
          const entry = yield* curated(ref.key);
          return {
            listing: curatedListing(entry, language),
            form: curatedForm(entry),
            fields: curatedDetails(list, entry, language).fields,
          };
        }
        const entry = yield* registryEntry(ref);
        if (entry.form === null) return yield* new Invalid({ reason: "connector-unsupported" });
        return {
          listing: registryListing(entry),
          form: entry.form,
          fields: contractFields(entry.form),
        };
      }),

      authorization: (ref) => {
        if (ref._tag === "registry") return NO_AUTHORIZATION;
        const entry = curatedEntry(list, ref.key);
        return entry === undefined ? NO_AUTHORIZATION : curatedAuthorization(list, entry);
      },
    });
  }),
);
