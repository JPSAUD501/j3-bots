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
 * Whose a stored credential is: the device id and the issuing server's
 * origin, kept in the clear, so a write's pairing check reads them in its
 * own transaction, and so a record of this server is told apart from
 * anything else before its token is looked at.
 */
const Pairing = Schema.Struct({ deviceId: DeviceId, server: Schema.String });

/**
 * The device credential as the desktop app keeps it in IndexedDB: whose it
 * is, and the token only as the app sealed it (`safeStorage`), with how it
 * was sealed.
 */
const SealedRecord = Schema.Struct({
  ...Pairing.fields,
  sealed: Sealed,
  protection: TokenProtection,
});
const decodePairing = Schema.decodeUnknownOption(Schema.fromJsonString(Pairing));
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(SealedRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(SealedRecord));
const decodeToken = Schema.decodeUnknownOption(DeviceToken);

/**
 * How long the app may take to seal or open the token: long enough for the
 * system to ask the operator to unlock a keyring and for Chromium to give up
 * on one that does not answer (its first seal took 24 s with the session's
 * keyring locked, before it fell back to its built-in key), but a bridge
 * that never answers must not hold the app's start, nor a save, for ever.
 */
export const SEALER_DEADLINE = Duration.seconds(60);

/** Whose `stored` is, if the server at `server` issued it. */
const pairingOf = (server: URL, stored: unknown) =>
  decodePairing(stored).pipe(Option.filter((pairing) => pairing.server === server.origin));

/** How the credential in `stored`, if the server at `server` issued it, keeps its token. */
export const storedProtection = (server: URL, stored: unknown): Option.Option<TokenProtection> =>
  decodeRecord(stored).pipe(
    Option.filter((record) => record.server === server.origin),
    Option.map((record) => record.protection),
  );

/** What the codec needs of the desktop app. */
export type TokenSealer = Pick<Desktop, "sealToken" | "openToken">;

const NOT_OPENED: OpenResult = { _tag: "unavailable" };

const unreadable = () => Effect.fail(new CredentialStorageError({ operation: "load" }));

/**
 * Reads and writes the credential of the server at `server` through
 * `sealer`. A value that is not a record of this server is absent, and so is
 * one whose token decrypts to something the app did not seal: the device
 * reads as not paired, and the operator pairs it again. A record of this
 * server whose token is not one the app could have sealed (missing, not
 * base64 in the form the app writes) is damaged storage, and so is a token
 * the app does not open (a locked keyring, a key the system no longer has,
 * no answer by `SEALER_DEADLINE`): it fails to load, and the pairing, with
 * what is kept for it, stays.
 */
export const sealedCredential = (server: URL, sealer: TokenSealer): CredentialCodec => ({
  pairingOf: (stored) => Option.map(pairingOf(server, stored), (pairing) => pairing.deviceId),
  open: (stored) =>
    Option.match(pairingOf(server, stored), {
      onNone: () => Effect.succeedNone,
      onSome: () =>
        Option.match(decodeRecord(stored), {
          onNone: unreadable,
          onSome: (record) =>
            Effect.promise(() => sealer.openToken(record.sealed)).pipe(
              Effect.timeoutOption(SEALER_DEADLINE),
              Effect.map(Option.getOrElse(() => NOT_OPENED)),
              Effect.flatMap((opened) => {
                switch (opened._tag) {
                  case "unavailable":
                    return unreadable();
                  case "failed":
                    return Effect.succeedNone;
                  case "opened":
                    return Effect.succeed(
                      Option.map(decodeToken(opened.token), (valid) => ({
                        deviceId: record.deviceId,
                        token: Redacted.make(valid),
                      })),
                    );
                }
              }),
            ),
        }),
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
});
