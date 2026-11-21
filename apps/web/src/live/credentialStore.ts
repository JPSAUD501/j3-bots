// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
} from "@j3-bots/client-runtime";
import { DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
   * Fails when it cannot be read now but may be later.
   */
  readonly open: (
    stored: unknown,
  ) => Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
  /** What is stored for `credential`. */
  readonly write: (credential: DeviceCredential) => Effect.Effect<string, CredentialStorageError>;
}

/** The one place the credential is stored. Each call may reject. */
export interface CredentialCell {
  readonly get: () => Promise<unknown>;
  readonly put: (value: string) => Promise<void>;
  /**
   * Replaces what is stored with `next`, or deletes it when `next` is null,
   * in one transaction, only if it is still `expected`.
   */
  readonly replace: (expected: string, next: string | null) => Promise<boolean>;
}

/**
 * What the cell holds in place of a credential the server refused: the
 * pairing that ended, nothing secret. No codec reads it as a credential, so
 * every window, and a tab still running an older build, finds none.
 */
const Refused = Schema.fromJsonString(Schema.Struct({ refused: DeviceId }));
const decodeRefused = Schema.decodeUnknownOption(Refused);
const encodeRefused = Schema.encodeSync(Refused);

/**
 * The `CredentialStore` over `cell`, reading and writing through `codec`.
 * `announce` tells the device's other windows that the credential changed,
 * and `changes` hears them.
 *
 * What a stored value opens to, or why it does not, is kept for as long as
 * that value is the one stored: reading the credential again, as the
 * client's start does a few times over, waits on the codec once. A value
 * the codec could not open now stays unopened until it changes, which in
 * the desktop app is what the system would answer anyway: it sees a
 * keyring unlocked since only once the app starts again.
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
  let opening: {
    readonly stored: unknown;
    readonly opened: Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
  } | null = null;
  const open = (found: unknown) =>
    opening !== null && opening.stored === found
      ? opening.opened
      : Effect.cached(codec.open(found)).pipe(
          Effect.flatMap((opened) => {
            // Another read of the same value may have got here first.
            if (opening === null || opening.stored !== found) opening = { stored: found, opened };
            return opening.opened;
          }),
        );
  const load = stored("load").pipe(Effect.flatMap(open));
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
    // Deletes only a value of `credential`'s pairing: if another window
    // stored a pairing since, it stays. A pairing is told by its device id,
    // read in the clear, so signing out needs nothing opened.
    clear: Effect.fn("CredentialStore.clear")(
      (credential: DeviceCredential, refusedByServer: boolean) =>
        stored("clear").pipe(
          Effect.flatMap((found) =>
            typeof found === "string" &&
            Option.contains(codec.pairingOf(found), credential.deviceId)
              ? Effect.tryPromise({
                  try: () =>
                    cell.replace(
                      found,
                      refusedByServer ? encodeRefused({ refused: credential.deviceId }) : null,
                    ),
                  catch: () => new CredentialStorageError({ operation: "clear" }),
                })
              : Effect.succeed(false),
          ),
          Effect.tap((cleared) => (cleared ? announce : Effect.void)),
          Effect.andThen(load),
        ),
    ),
    refusedPairing: stored("load").pipe(
      Effect.map((found) => Option.map(decodeRefused(found), ({ refused }) => refused)),
    ),
    changes: options.changes,
  });
};
