// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
} from "@j3-bots/client-runtime";
import type { DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";

/** The device credential as one stored value, and back: a browser's plain record, the desktop app's sealed one. */
export interface CredentialCodec {
  /**
   * The pairing `stored` belongs to, if it is this server's credential. Read
   * inside the storage transaction a write checks it in, so it cannot wait.
   */
  readonly pairingOf: (stored: unknown) => Option.Option<DeviceId>;
  /**
   * The credential `stored` holds, if it is this server's and can be read.
   * `stale` when it should be stored again, as whatever keeps it says. Fails
   * when it cannot be read now but may be later.
   */
  readonly open: (
    stored: unknown,
  ) => Effect.Effect<
    Option.Option<{ readonly credential: DeviceCredential; readonly stale: boolean }>,
    CredentialStorageError
  >;
  /** What is stored for `credential`. */
  readonly write: (credential: DeviceCredential) => Effect.Effect<string, CredentialStorageError>;
}

/** The one place the credential is stored. Each call may reject. */
export interface CredentialCell {
  readonly get: () => Promise<unknown>;
  readonly put: (value: string) => Promise<void>;
  /** Stores `next` (`null`: nothing) in one transaction, only if what is stored is still `expected`. */
  readonly swap: (expected: string, next: string | null) => Promise<boolean>;
}

/** How many times clearing reads and deletes the credential, while another window keeps sealing it again. */
const CLEAR_ATTEMPTS = 3;

const same = (a: DeviceCredential, b: DeviceCredential) =>
  a.deviceId === b.deviceId && Redacted.value(a.token) === Redacted.value(b.token);

/**
 * The `CredentialStore` over `cell`, reading and writing through `codec`.
 * `announce` tells the device's other windows that the credential changed,
 * and `changes` hears them.
 */
export const makeCredentialStore = (options: {
  readonly codec: CredentialCodec;
  readonly cell: CredentialCell;
  readonly announce: Effect.Effect<void>;
  readonly changes: Stream.Stream<void>;
}) => {
  const { codec, cell, announce } = options;
  const stored = (operation: CredentialStorageError["operation"]) =>
    Effect.tryPromise({
      try: () => cell.get(),
      catch: () => new CredentialStorageError({ operation }),
    });
  /** Stores `credential` again in place of `found`, if `found` is still there. Best effort. */
  const restore = (found: unknown, credential: DeviceCredential) =>
    typeof found === "string"
      ? codec.write(credential).pipe(
          Effect.flatMap((next) =>
            Effect.tryPromise({
              try: () => cell.swap(found, next),
              catch: () => new CredentialStorageError({ operation: "save" }),
            }),
          ),
          Effect.flatMap((stored) => (stored ? announce : Effect.void)),
          Effect.ignore,
        )
      : Effect.void;
  /**
   * Deletes what is stored while it is still `credential`, and says whether
   * it did. A delete is refused when the value changed since it was read;
   * another window sealing the same credential again changes the value, so
   * the read and the delete are tried again, a few times.
   */
  const remove = (
    credential: DeviceCredential,
    attempts: number,
  ): Effect.Effect<boolean, CredentialStorageError> =>
    stored("clear").pipe(
      Effect.flatMap((found) =>
        codec.open(found).pipe(
          Effect.flatMap((opened) =>
            typeof found === "string" &&
            Option.exists(opened, (current) => same(current.credential, credential))
              ? Effect.tryPromise({
                  try: () => cell.swap(found, null),
                  catch: () => new CredentialStorageError({ operation: "clear" }),
                }).pipe(
                  Effect.filterOrElse(
                    (cleared) => cleared || attempts <= 1,
                    () => remove(credential, attempts - 1),
                  ),
                )
              : Effect.succeed(false),
          ),
        ),
      ),
    );
  const load = stored("load").pipe(
    Effect.flatMap((found) =>
      codec.open(found).pipe(
        Effect.tap((opened) =>
          Option.isSome(opened) && opened.value.stale
            ? restore(found, opened.value.credential)
            : Effect.void,
        ),
        Effect.map(Option.map(({ credential }) => credential)),
      ),
    ),
  );
  return CredentialStore.of({
    load,
    save: Effect.fn("CredentialStore.save")((credential: DeviceCredential) =>
      codec.write(credential).pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: () => cell.put(value),
            catch: () => new CredentialStorageError({ operation: "save" }),
          }),
        ),
        Effect.andThen(announce),
      ),
    ),
    // Deletes only a value that holds `credential`: if another window stored
    // a pairing since, it stays.
    clear: Effect.fn("CredentialStore.clear")((credential: DeviceCredential) =>
      remove(credential, CLEAR_ATTEMPTS).pipe(
        Effect.tap((cleared) => (cleared ? announce : Effect.void)),
        Effect.andThen(load),
      ),
    ),
    changes: options.changes,
  });
};
