// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceCredential } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { CredentialCodec } from "./credentialStore";

/**
 * The device credential, as IndexedDB keeps it, with the origin of the server
 * that issued it. A non-extractable WebCrypto key would not help: the server
 * is also served over plain HTTP on a local network, where WebCrypto's subtle
 * API does not exist, and a script running on this origin could use such a
 * key as freely as read the token.
 *
 * A record with none is the server's at the page's own origin: a browser
 * writes it that way, as it always has, so a tab still running an older
 * build reads and clears it exactly as it wrote it. The desktop app's page
 * is never its server, so its records always name one.
 */
const StoredCredential = Schema.fromJsonString(
  Schema.Struct({
    deviceId: DeviceId,
    token: DeviceToken,
    server: Schema.optionalKey(Schema.String),
  }),
);
const decode = Schema.decodeUnknownOption(StoredCredential);
const encode = Schema.encodeSync(StoredCredential);

/** Reads and writes the stored credential of the server at `server`, for a page at `pageOrigin`. */
export interface CredentialRecord {
  /**
   * The credential in `stored`, if the server at `server` issued it. One
   * issued by another server is absent: its token must never reach this one.
   */
  readonly read: (stored: unknown) => Option.Option<DeviceCredential>;
  /** What is stored for `credential`, issued by the server at `server`. */
  readonly write: (credential: DeviceCredential) => string;
}

export const credentialRecord = (server: URL, pageOrigin: string): CredentialRecord => ({
  read: (stored) =>
    decode(stored).pipe(
      Option.filter((found) => (found.server ?? pageOrigin) === server.origin),
      Option.map(({ deviceId, token }) => ({ deviceId, token: Redacted.make(token) })),
    ),
  write: (credential) =>
    encode({
      deviceId: credential.deviceId,
      token: Redacted.value(credential.token),
      ...(server.origin === pageOrigin ? {} : { server: server.origin }),
    }),
});

/** The browser's record as the credential store reads and writes it. */
export const plainCredential = (record: CredentialRecord): CredentialCodec => ({
  pairingOf: (stored) => Option.map(record.read(stored), ({ deviceId }) => deviceId),
  open: (stored) =>
    Effect.succeed(Option.map(record.read(stored), (credential) => ({ credential, stale: false }))),
  write: (credential) => Effect.succeed(record.write(credential)),
  mayReplace: () => true,
});
