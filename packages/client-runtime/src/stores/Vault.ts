// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type Credential,
  type CredentialDraft,
  type CredentialField,
  CredentialId,
  type EntryId,
  type MasterPassword,
  type TotpPreview,
  type VaultError,
  type VaultStatus,
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
 * The vault as this client shows it: `loading` until the server first tells
 * its state, `unsupported` on a server from before 0.4.0, which has none.
 * `credentials` are the saved logins, without their values, while the vault
 * is unlocked; null while they are read and whenever it is not. `stale`: the
 * connection dropped, and what shows is what the server last told.
 */
export type VaultView =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "ready";
      readonly status: VaultStatus;
      readonly credentials: ReadonlyArray<Credential> | null;
      readonly stale: boolean;
    };

/** Why a request to the vault did not take effect. */
export type VaultFailure =
  /** The server refused it, with its reason: a wrong password, a locked vault, too many attempts. */
  | { readonly _tag: "refused"; readonly error: VaultError }
  | { readonly _tag: "not-paired" }
  /** The server failed unexpectedly. Its cause is in the server's log. */
  | { readonly _tag: "unexpected" };

export type VaultResult<A = void> =
  | { readonly _tag: "done"; readonly value: A }
  | { readonly _tag: "failed"; readonly failure: VaultFailure };

/** A login to save, and the bots it is allowed to from the start. */
export interface NewCredential extends CredentialDraft {
  readonly allowedBots: ReadonlyArray<BotId>;
}

/** What `update` changes of a login. Fields left out keep their value; `totp: null` removes it. */
export type CredentialChanges = Partial<CredentialDraft>;

/**
 * The operator's vault, on the server: its state, followed, and its saved
 * logins, read again whenever its revision moves while it is unlocked. Every
 * value goes to the server, and comes back, as a `Redacted`, and none is kept
 * here: a revealed value or a code is the caller's to show and let go of.
 *
 * Every request may run again on a new socket when the one it went out on
 * drops (`Connection.call`), which the server's requests take: a login is
 * saved under an id this client chose, once. A password change whose answer
 * was lost is the exception, since its retry checks a password that is no
 * longer the vault's and fails with `Invalid("master-password")`: the new
 * password unlocks it.
 */
export class Vault extends Context.Service<
  Vault,
  {
    readonly view: Readable<VaultView>;
    readonly setup: (password: MasterPassword) => Effect.Effect<VaultResult>;
    readonly unlock: (password: MasterPassword) => Effect.Effect<VaultResult>;
    readonly lock: Effect.Effect<VaultResult>;
    readonly changePassword: (
      current: MasterPassword,
      next: MasterPassword,
    ) => Effect.Effect<VaultResult>;
    /** Saves a new login; with `request`, it answers that save-login card. */
    readonly save: (
      credential: NewCredential,
      request: EntryId | null,
    ) => Effect.Effect<VaultResult<Credential>>;
    readonly update: (
      id: CredentialId,
      changes: CredentialChanges,
    ) => Effect.Effect<VaultResult<Credential>>;
    readonly remove: (id: CredentialId) => Effect.Effect<VaultResult>;
    readonly setAllowedBots: (
      id: CredentialId,
      bots: ReadonlyArray<BotId>,
    ) => Effect.Effect<VaultResult<Credential>>;
    /** One value of a login, which the server records as shown on this device. */
    readonly reveal: (
      id: CredentialId,
      field: CredentialField,
    ) => Effect.Effect<VaultResult<Redacted.Redacted<string>>>;
    readonly totpPreview: (id: CredentialId) => Effect.Effect<VaultResult<TotpPreview>>;
  }
>()("@j3-bots/client-runtime/stores/Vault") {}

/** The result of a request to the vault, for a UI that shows outcomes rather than causes. */
export const vaultResult = <A>(exit: Exit.Exit<A, VaultError | NotPaired>): VaultResult<A> => {
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

/** A new login's id, from `bytes` random bytes: 120 bits, in the alphabet the contract takes. */
export const credentialIdOf = (bytes: Uint8Array): CredentialId =>
  Schema.decodeSync(CredentialId)(
    `cred_${Array.from(bytes.subarray(0, ID_LENGTH), (byte) => ID_ALPHABET.charAt(byte & 31)).join("")}`,
  );

export const layer = Layer.effect(
  Vault,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const random = yield* SecureRandom.SecureRandom;
    const view = new Cell<VaultView>({ _tag: "loading" });

    const showCredentials = latestRead((credentials: ReadonlyArray<Credential> | null) =>
      view.update((current) => (current._tag === "ready" ? { ...current, credentials } : current)),
    );

    /** Follows the vault's state on one socket, reading the logins whenever they may have changed. */
    const follow = (client: J3RpcClient) => {
      let listed: number | null = null;
      return client["vault.status"]().pipe(
        Stream.runForEach((status) =>
          Effect.gen(function* () {
            view.update((current) => ({
              _tag: "ready",
              status,
              credentials:
                current._tag === "ready" && status.state === "unlocked"
                  ? current.credentials
                  : null,
              stale: false,
            }));
            if (status.state !== "unlocked") {
              listed = null;
              return yield* showCredentials(Effect.succeed(null));
            }
            if (listed === status.revision) return;
            listed = status.revision;
            // Locked again before the list came back: the next status says so.
            const ignore = () => Effect.void;
            yield* showCredentials(client["vault.list"]()).pipe(
              Effect.catchTags({
                Conflict: ignore,
                NotFound: ignore,
                Invalid: ignore,
                RateLimited: ignore,
              }),
            );
          }),
        ),
      );
    };

    yield* connection
      .eachSession((client) =>
        follow(client).pipe(
          Effect.andThen(Effect.never),
          Effect.catchDefect(() =>
            // A server from before the vault answers its requests with a defect.
            Effect.sync(() => view.set({ _tag: "unsupported" })).pipe(Effect.andThen(Effect.never)),
          ),
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
      use: (client: J3RpcClient) => Effect.Effect<A, VaultError | RpcClientError>,
    ): Effect.Effect<VaultResult<A>> =>
      connection.call(use).pipe(Effect.exit, Effect.map(vaultResult));

    const newId = random.randomBytes(ID_LENGTH).pipe(Effect.map(credentialIdOf));

    return Vault.of({
      view,
      setup: Effect.fn("Vault.setup")(function* (password: MasterPassword) {
        return yield* request((client) => client["vault.setup"]({ password }));
      }),
      unlock: Effect.fn("Vault.unlock")(function* (password: MasterPassword) {
        return yield* request((client) => client["vault.unlock"]({ password }));
      }),
      lock: request((client) => client["vault.lock"]()),
      changePassword: Effect.fn("Vault.changePassword")(function* (
        current: MasterPassword,
        next: MasterPassword,
      ) {
        return yield* request((client) => client["vault.changePassword"]({ current, next }));
      }),
      save: Effect.fn("Vault.save")(function* (credential: NewCredential, entry: EntryId | null) {
        const id = yield* newId;
        return yield* request((client) =>
          client["vault.save"]({ id, ...credential, request: entry }),
        );
      }),
      update: Effect.fn("Vault.update")(function* (id: CredentialId, changes: CredentialChanges) {
        return yield* request((client) => client["vault.update"]({ id, ...changes }));
      }),
      remove: Effect.fn("Vault.remove")(function* (id: CredentialId) {
        return yield* request((client) => client["vault.delete"]({ id }));
      }),
      setAllowedBots: Effect.fn("Vault.setAllowedBots")(function* (
        id: CredentialId,
        bots: ReadonlyArray<BotId>,
      ) {
        return yield* request((client) => client["vault.setAllowedBots"]({ id, bots }));
      }),
      reveal: Effect.fn("Vault.reveal")(function* (id: CredentialId, field: CredentialField) {
        return yield* request((client) => client["vault.reveal"]({ id, field }));
      }),
      totpPreview: Effect.fn("Vault.totpPreview")(function* (id: CredentialId) {
        return yield* request((client) => client["vault.totpPreview"]({ id }));
      }),
    });
  }),
);
