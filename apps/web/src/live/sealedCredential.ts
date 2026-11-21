// SPDX-License-Identifier: AGPL-3.0-or-later
import { CredentialStorageError } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import { type OpenResult, Sealed, TokenProtection } from "@j3-bots/desktop-bridge";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { CredentialCodec } from "./credentialStore";
import type { Desktop } from "./desktop";

/**
 * The device credential as the desktop app keeps it in IndexedDB: the device
 * id and the issuing server's origin in the clear, so a write's pairing check
 * reads them in its own transaction, and the token only as the app sealed it
 * (`safeStorage`), with how it was sealed.
 */
const SealedRecord = Schema.fromJsonString(
  Schema.Struct({
    deviceId: DeviceId,
    server: Schema.String,
    sealed: Schema.String,
    protection: TokenProtection,
  }),
);
const decodeRecord = Schema.decodeUnknownOption(SealedRecord);
const encodeRecord = Schema.encodeSync(SealedRecord);
const decodeToken = Schema.decodeUnknownOption(DeviceToken);
const isSealed = Schema.is(Sealed);

/**
 * How long the app may take to seal or open the token: long enough for the
 * system to ask the operator to unlock a keyring and for Chromium to give up
 * on one that does not answer (its first seal took 24 s with the session's
 * keyring locked, before it fell back to its built-in key), but a bridge
 * that never answers must not hold the app's start, nor a save, for ever.
 */
export const SEALER_DEADLINE = Duration.seconds(60);

/** The record in `stored`, if the server at `server` issued it. */
const recordOf = (server: URL, stored: unknown) =>
  decodeRecord(stored).pipe(Option.filter((record) => record.server === server.origin));

/** How the credential in `stored`, if the server at `server` issued it, keeps its token. */
export const storedProtection = (server: URL, stored: unknown): Option.Option<TokenProtection> =>
  Option.map(recordOf(server, stored), (record) => record.protection);

/** What the codec needs of the desktop app. */
export type TokenSealer = Pick<Desktop, "sealToken" | "openToken">;

const NOT_OPENED: OpenResult = { _tag: "unavailable" };

/**
 * What `sealer` opens `sealed` to. A value that is not a sealed token was
 * never opened, so it says nothing of whose it is: like no answer, it is
 * `unavailable`.
 */
const openToken = (sealer: TokenSealer, sealed: string): Effect.Effect<OpenResult> =>
  isSealed(sealed)
    ? Effect.promise(() => sealer.openToken(sealed)).pipe(
        Effect.timeoutOption(SEALER_DEADLINE),
        Effect.map(Option.getOrElse(() => NOT_OPENED)),
      )
    : Effect.succeed(NOT_OPENED);

/**
 * Reads and writes the credential of the server at `server` through
 * `sealer`. A record of another server is absent, and so is one whose token
 * decrypts to something the app did not seal: the device reads as not
 * paired, and the operator pairs it again. A token the app does not open
 * (a locked keyring, a key the system no longer has, a sealed value that is
 * not one, no answer by `SEALER_DEADLINE`) fails to load instead: the
 * pairing, and what is kept for it, stays until it opens. A token sealed
 * again never replaces one kept encrypted with one kept unencrypted.
 */
export const sealedCredential = (server: URL, sealer: TokenSealer): CredentialCodec => ({
  pairingOf: (stored) => Option.map(recordOf(server, stored), (record) => record.deviceId),
  open: (stored) =>
    Option.match(recordOf(server, stored), {
      onNone: () => Effect.succeedNone,
      onSome: (record) =>
        openToken(sealer, record.sealed).pipe(
          Effect.flatMap((opened) => {
            switch (opened._tag) {
              case "unavailable":
                return Effect.fail(new CredentialStorageError({ operation: "load" }));
              case "failed":
                return Effect.succeedNone;
              case "opened":
                return Effect.succeed(
                  Option.map(decodeToken(opened.token), (valid) => ({
                    credential: { deviceId: record.deviceId, token: Redacted.make(valid) },
                    stale: opened.stale,
                  })),
                );
            }
          }),
        ),
    }),
  write: (credential) =>
    Effect.promise(() => sealer.sealToken(Redacted.value(credential.token))).pipe(
      Effect.timeoutOption(SEALER_DEADLINE),
      Effect.map(Option.getOrNull),
      Effect.flatMap((sealed) =>
        sealed === null
          ? Effect.fail(new CredentialStorageError({ operation: "save" }))
          : Effect.succeed(
              encodeRecord({
                deviceId: credential.deviceId,
                server: server.origin,
                sealed: sealed.sealed,
                protection: sealed.protection,
              }),
            ),
      ),
    ),
  mayReplace: (stored, next) =>
    !Option.contains(storedProtection(server, stored), "encrypted") ||
    Option.contains(storedProtection(server, next), "encrypted"),
});
