// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandError,
  type CommandLine,
  type Connector,
  type ConnectorFieldValue,
  type ConnectorGrant,
  ConnectorId,
  type ConnectorListing,
  type ConnectorListingDetails,
  type ConnectorSource,
  type EntryId,
  type Language,
  type ListingRef,
  type SignInRedirect,
  type SignInStarted,
  type ToolReviewRevision,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Connection, type NotPaired } from "../connection/Connection.ts";
import { Actions, type IntentResult, intentResult } from "../intents/Actions.ts";
import { applyConnectorChange } from "../presentation/connectors.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** What a search of the gallery found, and whether the MCP Registry answered in time. */
export interface ConnectorSearch {
  readonly listings: ReadonlyArray<ConnectorListing>;
  readonly registry: "answered" | "unavailable";
}

/** A connector to add: where from, which bots may use it, and the card that suggested it. */
export interface ConnectorAddition {
  readonly source: ConnectorSource;
  /** Left out: the bot whose card `suggestion` is, else the primary bot. */
  readonly grant?: ConnectorGrant;
  readonly suggestion: EntryId | null;
}

/**
 * What changes in a connector the operator added: its name, values its form
 * took, or a command connector's whole command line, once the operator
 * confirmed it.
 */
export interface ConnectorChanges {
  readonly name?: Connector["name"];
  readonly values?: ReadonlyArray<ConnectorFieldValue>;
  readonly command?: CommandLine;
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * The operator's connectors, kept live on every socket, and the gallery to
 * find more in. A request that carries a value or a sign-in has no command
 * id (`ConnectorRpcs`): each is safe to send again as it stands, so a socket
 * that drops sends it again.
 */
export class Connectors extends Context.Service<
  Connectors,
  {
    readonly state: Readable<Synced<ReadonlyArray<Connector>>>;
    /** What the gallery features, in `language`. */
    readonly featured: (
      language: Language,
    ) => Effect.Effect<IntentResult<ReadonlyArray<ConnectorListing>>>;
    /** Without `all`, only listings every client can connect. */
    readonly search: (input: {
      readonly query: string;
      readonly language: Language;
      readonly all: boolean;
    }) => Effect.Effect<IntentResult<ConnectorSearch>>;
    readonly listing: (
      ref: ListingRef,
      language: Language,
    ) => Effect.Effect<IntentResult<ConnectorListingDetails>>;
    /** Adds it under an id of this client's, so a retry finds the connector it added. */
    readonly add: (addition: ConnectorAddition) => Effect.Effect<IntentResult<Connector>>;
    readonly update: (
      connectorId: ConnectorId,
      changes: ConnectorChanges,
    ) => Effect.Effect<IntentResult<Connector>>;
    readonly remove: (connectorId: ConnectorId) => Effect.Effect<IntentResult>;
    readonly setBots: (
      connectorId: ConnectorId,
      grant: ConnectorGrant,
    ) => Effect.Effect<IntentResult<Connector>>;
    readonly answerToolReview: (
      connectorId: ConnectorId,
      revision: ToolReviewRevision,
      decision: "accept" | "keep",
    ) => Effect.Effect<IntentResult<Connector>>;
    /** A sign-in only this device can finish, which it opens in the system browser. */
    readonly beginSignIn: (
      connectorId: ConnectorId,
      redirect: SignInRedirect,
    ) => Effect.Effect<IntentResult<SignInStarted>>;
    /** Finishes a `relay` or `paste` sign-in with the address the browser returned to. */
    readonly completeSignIn: (url: Redacted.Redacted<string>) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Connectors") {}

export const layer = Layer.effect(
  Connectors,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const random = yield* SecureRandom.SecureRandom;
    const state = new Cell<Synced<ReadonlyArray<Connector>>>(loading);

    yield* connection
      .eachSession((client) =>
        client["connectors.subscribe"]().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() =>
              state.update((current) =>
                event._tag === "snapshot"
                  ? ready(event.connectors)
                  : ready(
                      applyConnectorChange(
                        current._tag === "ready" ? current.value : [],
                        event.upsert,
                        event.remove,
                      ),
                    ),
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    /** Shows a connector the server answered with before its change comes through the subscription. */
    const show = (connector: Connector) =>
      Effect.sync(() =>
        state.update((current) =>
          current._tag === "ready"
            ? { ...current, value: applyConnectorChange(current.value, [connector], []) }
            : current,
        ),
      );

    const answered = <A>(effect: Effect.Effect<A, CommandError | NotPaired>) =>
      effect.pipe(Effect.exit, Effect.map(intentResult));

    const connectorId = random
      .randomBytes(24)
      .pipe(
        Effect.map((bytes) =>
          ConnectorId.make(
            `conn_${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")}`,
          ),
        ),
      );

    const add = Effect.fn("Connectors.add")(function* (addition: ConnectorAddition) {
      const id = yield* connectorId;
      return yield* answered(
        connection
          .call((client) =>
            client["connector.add"]({
              id,
              source: addition.source,
              suggestion: addition.suggestion,
              ...(addition.grant === undefined ? {} : { grant: addition.grant }),
            }),
          )
          .pipe(Effect.tap(show)),
      );
    });

    const setBots = Effect.fn("Connectors.setBots")(function* (
      connectorId: ConnectorId,
      grant: ConnectorGrant,
    ) {
      const commandId = yield* actions.commandId;
      return yield* answered(
        connection
          .call((client) => client["connector.setBots"]({ commandId, connectorId, grant }))
          .pipe(Effect.tap(show)),
      );
    });

    const remove = Effect.fn("Connectors.remove")(function* (connectorId: ConnectorId) {
      const commandId = yield* actions.commandId;
      return yield* answered(
        connection
          .call((client) => client["connector.remove"]({ commandId, connectorId }))
          .pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                state.update((current) =>
                  current._tag === "ready"
                    ? { ...current, value: applyConnectorChange(current.value, [], [connectorId]) }
                    : current,
                ),
              ),
            ),
          ),
      );
    });

    const answerToolReview = Effect.fn("Connectors.answerToolReview")(function* (
      connectorId: ConnectorId,
      revision: ToolReviewRevision,
      decision: "accept" | "keep",
    ) {
      const commandId = yield* actions.commandId;
      return yield* answered(
        connection
          .call((client) =>
            client["connector.acceptToolChanges"]({ commandId, connectorId, revision, decision }),
          )
          .pipe(Effect.tap(show)),
      );
    });

    const featured = Effect.fn("Connectors.featured")(function* (language: Language) {
      return yield* answered(connection.call((client) => client["connectors.list"]({ language })));
    });

    const search = Effect.fn("Connectors.search")(function* (input: {
      readonly query: string;
      readonly language: Language;
      readonly all: boolean;
    }) {
      return yield* answered(connection.call((client) => client["connectors.search"](input)));
    });

    const listing = Effect.fn("Connectors.listing")(function* (
      ref: ListingRef,
      language: Language,
    ) {
      return yield* answered(
        connection.call((client) => client["connectors.get"]({ ref, language })),
      );
    });

    const update = Effect.fn("Connectors.update")(function* (
      connectorId: ConnectorId,
      changes: ConnectorChanges,
    ) {
      return yield* answered(
        connection
          .call((client) => client["connector.update"]({ connectorId, ...changes }))
          .pipe(Effect.tap(show)),
      );
    });

    const beginSignIn = Effect.fn("Connectors.beginSignIn")(function* (
      connectorId: ConnectorId,
      redirect: SignInRedirect,
    ) {
      return yield* answered(
        connection.call((client) => client["connector.beginSignIn"]({ connectorId, redirect })),
      );
    });

    const completeSignIn = Effect.fn("Connectors.completeSignIn")(function* (
      url: Redacted.Redacted<string>,
    ) {
      return yield* answered(
        connection.call((client) => client["connector.completeSignIn"]({ url })),
      );
    });

    return Connectors.of({
      state,
      featured,
      search,
      listing,
      add,
      update,
      remove,
      setBots,
      answerToolReview,
      beginSignIn,
      completeSignIn,
    });
  }),
);
