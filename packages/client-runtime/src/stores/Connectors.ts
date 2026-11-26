// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type CommandError,
  type CommandLine,
  type Connector,
  type ConnectorAppAnswer,
  type ConnectorAppView,
  type ConnectorAppViewId,
  type ConnectorFieldValue,
  type ConnectorGrant,
  ConnectorId,
  type ConnectorListing,
  type ConnectorListingDetails,
  type ConnectorPrompt,
  type ConnectorSource,
  type Language,
  type ListingRef,
  type PromptArguments,
  type SignInRedirect,
  type SignInStarted,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
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

/** A connector to add: where from, and which bots may use it. */
export interface ConnectorAddition {
  readonly source: ConnectorSource;
  /** Left out: every bot. */
  readonly grant?: ConnectorGrant;
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
    /** The prompts the connectors `botId` may use offer, for the `/` menu of its conversation. */
    readonly prompts: (botId: BotId) => Effect.Effect<IntentResult<ReadonlyArray<ConnectorPrompt>>>;
    /** A prompt as its server writes it from the operator's arguments, for their draft. */
    readonly renderPrompt: (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: PromptArguments;
    }) => Effect.Effect<IntentResult<{ readonly text: string; readonly cut: boolean }>>;
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
    /** A sign-in only this device can finish, which it opens in the system browser. */
    readonly beginSignIn: (
      connectorId: ConnectorId,
      redirect: SignInRedirect,
    ) => Effect.Effect<IntentResult<SignInStarted>>;
    /** Finishes a `relay` or `paste` sign-in with the address the browser returned to. */
    readonly completeSignIn: (url: Redacted.Redacted<string>) => Effect.Effect<IntentResult>;
    /** A connector's app a turn's work shows, ready to draw. */
    readonly openApp: (viewId: ConnectorAppViewId) => Effect.Effect<IntentResult<ConnectorAppView>>;
    /** A tool call an app asked for, made as the bot whose call opened it; `allowed` once the operator allowed it. */
    readonly callAppTool: (
      viewId: ConnectorAppViewId,
      name: string,
      args: Schema.JsonObject,
      allowed: boolean,
    ) => Effect.Effect<IntentResult<ConnectorAppAnswer>>;
    /** A resource an app asked to read, of its own connector. */
    readonly readAppResource: (
      viewId: ConnectorAppViewId,
      uri: string,
    ) => Effect.Effect<IntentResult<ConnectorAppAnswer>>;
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

    const prompts = Effect.fn("Connectors.prompts")(function* (botId: BotId) {
      return yield* answered(connection.call((client) => client["connector.prompts"]({ botId })));
    });

    const renderPrompt = Effect.fn("Connectors.renderPrompt")(function* (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: PromptArguments;
    }) {
      return yield* answered(connection.call((client) => client["connector.renderPrompt"](input)));
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

    const openApp = Effect.fn("Connectors.openApp")(function* (viewId: ConnectorAppViewId) {
      return yield* answered(connection.call((client) => client["connectorApp.open"]({ viewId })));
    });

    const callAppTool = Effect.fn("Connectors.callAppTool")(function* (
      viewId: ConnectorAppViewId,
      name: string,
      args: Schema.JsonObject,
      allowed: boolean,
    ) {
      return yield* answered(
        connection.call((client) =>
          client["connectorApp.callTool"]({ viewId, name, arguments: args, allowed }),
        ),
      );
    });

    const readAppResource = Effect.fn("Connectors.readAppResource")(function* (
      viewId: ConnectorAppViewId,
      uri: string,
    ) {
      return yield* answered(
        connection.call((client) => client["connectorApp.readResource"]({ viewId, uri })),
      );
    });

    return Connectors.of({
      state,
      prompts,
      renderPrompt,
      featured,
      search,
      listing,
      add,
      update,
      remove,
      setBots,
      beginSignIn,
      completeSignIn,
      openApp,
      callAppTool,
      readAppResource,
    });
  }),
);
