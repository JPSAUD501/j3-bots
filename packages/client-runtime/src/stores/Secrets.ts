// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandError,
  type EntryId,
  type Secret,
  type SecretAccess,
  type SecretChanges,
  type SecretDraft,
  type SecretField,
  SecretId,
  type SecretName,
  type SecretsStatus,
  type TotpPreview,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { Connection, type J3RpcClient, type NotPaired } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { latestRead } from "./Settings.ts";

/**
 * The operator's secrets as this client shows them: `loading` until the
 * server first tells their state. `secrets` are the saved ones, without
 * their values, while the state is `ready`; null while they are read and
 * whenever it is not. `listFailure`: why they could not be read, as when
 * the file is damaged; null otherwise. `stale`: the connection dropped, and
 * what shows is what the server last told.
 */
export type SecretsView =
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "ready";
      readonly status: SecretsStatus;
      readonly secrets: ReadonlyArray<Secret> | null;
      readonly listFailure: SecretsFailure | null;
      readonly stale: boolean;
    };

/** Why a request about secrets did not take effect. */
export type SecretsFailure =
  /** The server refused it, with its reason: a name taken, a one-time code setup it can't read. */
  | { readonly _tag: "refused"; readonly error: CommandError }
  | { readonly _tag: "not-paired" }
  /** The server failed unexpectedly. Its cause is in the server's log. */
  | { readonly _tag: "unexpected" };

export type SecretsResult<A = void> =
  | { readonly _tag: "done"; readonly value: A }
  | { readonly _tag: "failed"; readonly failure: SecretsFailure };

/** A secret to add: its name, its values, and the bots that may use it. */
export interface NewSecret {
  readonly name: SecretName;
  readonly draft: SecretDraft;
  readonly access: SecretAccess;
}

/**
 * The operator's secrets, on the server: their state, followed, and the list,
 * read again whenever the revision moves while they are `ready`. Every value
 * goes to the server, and comes back, as a `Redacted`, and none is kept here:
 * a revealed value or a code is the caller's to show and let go of.
 *
 * Every request may run again on a new socket when the one it went out on
 * drops (`Connection.call`), which the server's requests take: a secret is
 * added under an id this client chose, once, and opening an old vault that
 * is open already succeeds.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    readonly view: Readable<SecretsView>;
    /** Adds a secret; with `request`, it answers that bot's ask for it. */
    readonly add: (
      secret: NewSecret,
      request: EntryId | null,
    ) => Effect.Effect<SecretsResult<Secret>>;
    readonly update: (id: SecretId, changes: SecretChanges) => Effect.Effect<SecretsResult<Secret>>;
    readonly remove: (id: SecretId) => Effect.Effect<SecretsResult>;
    readonly setAccess: (
      id: SecretId,
      access: SecretAccess,
    ) => Effect.Effect<SecretsResult<Secret>>;
    /** One value of a secret, which the server records as shown on this device. */
    readonly reveal: (
      id: SecretId,
      field: SecretField,
    ) => Effect.Effect<SecretsResult<Redacted.Redacted<string>>>;
    readonly totpPreview: (id: SecretId) => Effect.Effect<SecretsResult<TotpPreview>>;
  }
>()("@j3-bots/client-runtime/stores/Secrets") {}

/** The result of a request, for a UI that shows outcomes rather than causes. */
const secretsResult = <A>(exit: Exit.Exit<A, CommandError | NotPaired>): SecretsResult<A> => {
  if (Exit.isSuccess(exit)) return { _tag: "done", value: exit.value };
  const error = Cause.findErrorOption(exit.cause);
  if (error._tag === "None") return { _tag: "failed", failure: { _tag: "unexpected" } };
  return {
    _tag: "failed",
    failure:
      error.value._tag === "NotPaired"
        ? { _tag: "not-paired" }
        : { _tag: "refused", error: error.value },
  };
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 24;

/** A new secret's id, from `bytes` random bytes: 120 bits, in the alphabet the contract takes. */
const secretIdOf = (bytes: Uint8Array): SecretId =>
  Schema.decodeSync(SecretId)(
    `sec_${Array.from(bytes.subarray(0, ID_LENGTH), (byte) => ID_ALPHABET.charAt(byte & 31)).join("")}`,
  );

export const layer = Layer.effect(
  Secrets,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const random = yield* SecureRandom.SecureRandom;
    const view = new Cell<SecretsView>({ _tag: "loading" });

    const showSecrets = latestRead(
      (listed: {
        readonly secrets: ReadonlyArray<Secret> | null;
        readonly listFailure: SecretsFailure | null;
      }) =>
        view.update((current) => (current._tag === "ready" ? { ...current, ...listed } : current)),
    );
    const notListed = { secrets: null, listFailure: null };
    const refused = (error: CommandError) =>
      Effect.succeed({ secrets: null, listFailure: { _tag: "refused", error } as const });

    /** Follows the secrets' state on one socket, reading the list whenever it may have changed. */
    const follow = (client: J3RpcClient) => {
      let listed: number | null = null;
      return client["secrets.status"]().pipe(
        Stream.runForEach((status) =>
          Effect.gen(function* () {
            view.update((current) => {
              const kept = current._tag === "ready" && status.state === "ready";
              return {
                _tag: "ready",
                status,
                secrets: kept ? current.secrets : null,
                listFailure: kept ? current.listFailure : null,
                stale: false,
              };
            });
            if (status.state !== "ready") {
              listed = null;
              return yield* showSecrets(Effect.succeed(notListed));
            }
            if (listed === status.revision) return;
            listed = status.revision;
            yield* showSecrets(
              client["secrets.list"]().pipe(
                Effect.map((secrets) => ({ secrets, listFailure: null })),
                Effect.catchTags({
                  // No longer ready before the list came back: the next status says so.
                  Conflict: (error) =>
                    error.reason === "secrets-unavailable"
                      ? Effect.succeed(notListed)
                      : refused(error),
                  NotFound: refused,
                  Invalid: refused,
                }),
                Effect.catchDefect(() =>
                  Effect.succeed({ secrets: null, listFailure: { _tag: "unexpected" } as const }),
                ),
              ),
            );
          }),
        ),
      );
    };

    yield* connection
      .eachSession((client) =>
        follow(client).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() =>
              view.update((current) =>
                current._tag === "ready" && !current.stale ? { ...current, stale: true } : current,
              ),
            ),
          ),
        ),
      )
      .pipe(Effect.forkScoped);

    const request = <A>(
      use: (client: J3RpcClient) => Effect.Effect<A, CommandError | RpcClientError>,
    ): Effect.Effect<SecretsResult<A>> =>
      connection.call(use).pipe(Effect.exit, Effect.map(secretsResult));

    const newId = random.randomBytes(ID_LENGTH).pipe(Effect.map(secretIdOf));

    return Secrets.of({
      view,
      add: Effect.fn("Secrets.add")(function* (secret: NewSecret, entry: EntryId | null) {
        const id = yield* newId;
        return yield* request((client) => client["secrets.add"]({ id, ...secret, request: entry }));
      }),
      update: Effect.fn("Secrets.update")(function* (id: SecretId, changes: SecretChanges) {
        return yield* request((client) => client["secrets.update"]({ id, changes }));
      }),
      remove: Effect.fn("Secrets.remove")(function* (id: SecretId) {
        return yield* request((client) => client["secrets.delete"]({ id }));
      }),
      setAccess: Effect.fn("Secrets.setAccess")(function* (id: SecretId, access: SecretAccess) {
        return yield* request((client) => client["secrets.setAccess"]({ id, access }));
      }),
      reveal: Effect.fn("Secrets.reveal")(function* (id: SecretId, field: SecretField) {
        return yield* request((client) => client["secrets.reveal"]({ id, field }));
      }),
      totpPreview: Effect.fn("Secrets.totpPreview")(function* (id: SecretId) {
        return yield* request((client) => client["secrets.totpPreview"]({ id }));
      }),
    });
  }),
);
