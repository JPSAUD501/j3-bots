// SPDX-License-Identifier: AGPL-3.0-or-later
import { SecretsUnavailable } from "@j3-bots/connectors";
import { BotId, type ConnectorId, EntryId, type OAuthClientInput } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { Entries } from "../../entries/Entries.ts";
import { ConnectorSignIns } from "../auth.ts";
import { ConnectorStore } from "../ConnectorStore.ts";
import { NO_AUTHORIZATION } from "../sources/Curated.ts";
import { ConnectorSources } from "../sources/Sources.ts";
import { ConnectorAuth, OAuthConnectors } from "./ConnectorAuth.ts";
import { toCommandError } from "./errors.ts";

// Where the rest of the server meets OAuth sign-ins: the connectors' store
// tells `ConnectorAuth` which connectors sign in with OAuth, and the gallery
// what an entry's sign-in asks for, and
// `ConnectorAuth` answers the connectors' sign-in port, with the
// `connector-auth` card a bot's call raises when it needs a sign-in.

/** The connectors that sign in with OAuth, from the connectors' store. */
export const connectorsLayer = Layer.effect(
  OAuthConnectors,
  Effect.gen(function* () {
    const store = yield* ConnectorStore;
    const sources = yield* ConnectorSources;
    const signInOf = Effect.fn("OAuthConnectors.signInOf")(function* (id: ConnectorId) {
      return Option.map(yield* store.get(id), ({ signIn }) => signIn);
    });
    const authorizationOf = Effect.fn("OAuthConnectors.authorizationOf")(function* (
      id: ConnectorId,
    ) {
      const connector = yield* store.get(id);
      const listing = Option.flatMapNullishOr(connector, ({ listing }) => listing);
      return Option.match(listing, {
        onNone: () => NO_AUTHORIZATION,
        onSome: (ref) => sources.authorization(ref),
      });
    });
    return OAuthConnectors.of({
      signInOf,
      all: Effect.map(store.all, (connectors) =>
        connectors.filter(({ signIn }) => signIn === "oauth").map(({ id }) => id),
      ),
      authorizationOf,
    });
  }),
);

type CardStatus = "signed-in" | "removed";

/** An open card's row, as `openCards` reads it. */
const decodeOpenCards = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: EntryId, conversation_bot_id: Schema.NullOr(BotId) })),
);

/**
 * The connectors' sign-in port, answered by `ConnectorAuth`. A bot's call
 * that needs a sign-in puts one `connector-auth` card in that bot's
 * conversation, which stays the only one until the operator signs in: then
 * every open card for the connector closes as `signed-in`, or as `removed`
 * with the connector. A state that returns to signed-in by itself, as on
 * the secrets becoming readable again, closes none.
 */
export const layer = Layer.effect(
  ConnectorSignIns,
  Effect.gen(function* () {
    const auth = yield* ConnectorAuth;
    const store = yield* ConnectorStore;
    const entries = yield* Entries;
    const sql = yield* SqlClient.SqlClient;
    // One card is checked for and written at a time, so two calls that both
    // find the sign-in gone raise one card.
    const cards = Semaphore.makeUnsafe(1);

    /** The open cards for the connector, and whose conversation each is in. */
    const openCards = (connectorId: ConnectorId) =>
      sql`
        SELECT id, conversation_bot_id FROM entries
        WHERE kind = 'connector-auth'
          AND json_extract(body_json, '$.connectorId') = ${connectorId}
          AND json_extract(body_json, '$.status') = 'pending'
      `.pipe(Effect.flatMap(decodeOpenCards), Effect.orDie);

    const close = Effect.fn("ConnectorSignIns.close")(function* (
      connectorId: ConnectorId,
      status: CardStatus,
    ) {
      yield* cards.withPermits(1)(
        Effect.gen(function* () {
          for (const { id } of yield* openCards(connectorId)) {
            const found = yield* entries.find(id);
            if (Option.isNone(found)) continue;
            const card = found.value.entry;
            if (card._tag !== "connector-auth" || card.status !== "pending") continue;
            yield* entries.update({ ...card, status });
          }
        }),
      );
    });

    const needed = Effect.fn("ConnectorSignIns.needed")(function* (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
    }) {
      yield* cards.withPermits(1)(
        Effect.gen(function* () {
          const open = yield* openCards(input.connectorId);
          if (open.some((card) => card.conversation_bot_id === input.botId)) return;
          const connector = yield* store.get(input.connectorId);
          if (Option.isNone(connector)) return;
          // The bot asks for the service's credentials instead (`add_mcp_server`'s note).
          if (yield* auth.signsInServicesOnly(input.connectorId)) return;
          yield* entries.append({
            target: { _tag: "conversation", botId: input.botId },
            entry: {
              _tag: "connector-auth",
              author: { _tag: "bot", botId: input.botId },
              connectorId: input.connectorId,
              name: connector.value.name,
              glyph: connector.value.glyph,
              status: "pending",
            },
          });
        }),
      );
    });

    // A sign-in the operator completes closes the cards that asked for it.
    const completed = yield* auth.signedIn;
    yield* completed.pipe(
      Stream.runForEach((id) => close(id, "signed-in")),
      Effect.forkScoped,
    );

    const disconnect = Effect.fn("ConnectorSignIns.disconnect")(function* (id: ConnectorId) {
      // The connector is gone for the operator either way, and so are its cards.
      const ended = yield* Effect.result(auth.disconnect(id));
      yield* close(id, "removed");
      if (ended._tag === "Success") return;
      // Its tokens are in the secrets: the removal ends them once they can be read.
      if (ended.failure.reason === "secrets-unavailable") return yield* new SecretsUnavailable();
      yield* Effect.logWarning("A connector's sign-in could not be ended").pipe(
        Effect.annotateLogs({ connector: id, reason: ended.failure.reason }),
      );
    });

    const useOperatorClient = Effect.fn("ConnectorSignIns.useOperatorClient")(function* (
      id: ConnectorId,
      client: OAuthClientInput,
    ) {
      yield* auth.useOperatorClient(id, {
        issuer: client.issuer,
        clientId: client.clientId,
        clientSecret: Option.fromNullOr(client.clientSecret),
      });
    }, Effect.mapError(toCommandError));

    const useServiceCredentials = Effect.fn("ConnectorSignIns.useServiceCredentials")(function* (
      id: ConnectorId,
    ) {
      yield* auth
        .disconnect(id)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("A connector's sign-in could not be ended").pipe(
              Effect.annotateLogs({ connector: id, reason: error.reason }),
            ),
          ),
        );
      yield* close(id, "signed-in");
    });

    const serviceIssuer = (input: Parameters<typeof auth.serviceIssuer>[0]) =>
      auth.serviceIssuer(input).pipe(Effect.mapError(toCommandError));

    return ConnectorSignIns.of({
      accessToken: auth.accessToken,
      rejected: auth.rejected,
      serviceIssuer,
      useServiceCredentials,
      signsInServicesOnly: auth.signsInServicesOnly,
      serviceToken: auth.serviceToken,
      serviceRejected: auth.serviceRejected,
      serviceRefused: auth.serviceRefused,
      needed,
      disconnect,
      useOperatorClient,
      states: auth.states,
    });
  }),
);
