// SPDX-License-Identifier: AGPL-3.0-or-later
import { CredentialStorageError } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import { TokenProtection } from "@j3-bots/desktop-bridge";
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

/** The record in `stored`, if the server at `server` issued it. */
const recordOf = (server: URL, stored: unknown) =>
  decodeRecord(stored).pipe(Option.filter((record) => record.server === server.origin));

/** How the credential in `stored`, if the server at `server` issued it, keeps its token. */
export const storedProtection = (server: URL, stored: unknown): Option.Option<TokenProtection> =>
  Option.map(recordOf(server, stored), (record) => record.protection);

/** What the codec needs of the desktop app. */
export type TokenSealer = Pick<Desktop, "sealToken" | "openToken">;

/**
 * Reads and writes the credential of the server at `server` through
 * `sealer`. A record of another server is absent, and so is one whose token
 * decrypts to something the app did not seal: the device reads as not
 * paired, and the operator pairs it again. A token the app cannot open now
 * (a locked keyring, a key the system no longer has) fails to load instead:
 * the pairing, and what is kept for it, stays until it opens.
 */
export const sealedCredential = (server: URL, sealer: TokenSealer): CredentialCodec => ({
  pairingOf: (stored) => Option.map(recordOf(server, stored), (record) => record.deviceId),
  open: (stored) =>
    Option.match(recordOf(server, stored), {
      onNone: () => Effect.succeedNone,
      onSome: (record) =>
        Effect.promise(() => sealer.openToken(record.sealed)).pipe(
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
