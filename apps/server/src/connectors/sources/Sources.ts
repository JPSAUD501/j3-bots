// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  type ConnectKind,
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
  type CuratedEntry,
  curatedCovers,
  curatedDetails,
  curatedEntry,
  curatedFind,
  curatedVariants,
  curatedForm,
  curatedListing,
  curatedMatches,
} from "./Curated.ts";
import { type ConnectForm, contractFields, plainText } from "./form.ts";
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
 * the operator gave into the address and headers to send, and how it signs in.
 */
interface ListingConnection {
  readonly listing: ConnectorListing;
  readonly form: ConnectForm;
  /**
   * For an `own-app` listing, the scopes it asks for and the parameters every
   * sign-in through that app adds.
   */
  readonly ownApp: {
    readonly scopes: ReadonlyArray<string>;
    readonly authorizationParameters: Readonly<Record<string, string>>;
  } | null;
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
    /**
     * The listing a bot means when it suggests `service`: an entry of the
     * curated list, never of the registry, which anyone can publish to.
     */
    readonly find: (service: string, language: Language) => Option.Option<ConnectorListing>;
    /**
     * The listings that are the same service as `ref`: itself and the curated
     * entries that connect to the same address another way.
     */
    readonly variants: (ref: ListingRef) => ReadonlyArray<ListingRef>;
    /** One listing's page. */
    readonly get: (
      ref: ListingRef,
      language: Language,
    ) => Effect.Effect<ConnectorListingDetails, NotFound | Conflict>;
    /** What adding the listing `ref` needs: its form and how it signs in. */
    readonly connection: (
      ref: ListingRef,
      language: Language,
    ) => Effect.Effect<ListingConnection, NotFound | Conflict | Invalid>;
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

    const ownAppOf = (entry: CuratedEntry): ListingConnection["ownApp"] => {
      if (entry.connect.kind !== "own-app") return null;
      const app = list.apps[entry.connect.app];
      return {
        scopes: entry.connect.scopes,
        authorizationParameters: app?.authorizationParameters ?? {},
      };
    };

    return ConnectorSources.of({
      list: (language) => list.connectors.map((entry) => curatedListing(entry, language)),

      find: (service, language) =>
        Option.map(Option.fromUndefinedOr(curatedFind(list, service)), (entry) =>
          curatedListing(entry, language),
        ),

      variants: (ref) => {
        if (ref._tag === "registry") return [ref];
        const found = curatedVariants(list, ref.key);
        return found.length === 0 ? [ref] : found;
      },

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
            ownApp: ownAppOf(entry),
          };
        }
        const entry = yield* registryEntry(ref);
        if (entry.form === null) return yield* new Invalid({ reason: "connector-unsupported" });
        return { listing: registryListing(entry), form: entry.form, ownApp: null };
      }),
    });
  }),
);
