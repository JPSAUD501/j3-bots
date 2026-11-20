// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { DeviceId, Label } from "./base.ts";

/** A paired client. */
export const Device = Schema.Struct({
  id: DeviceId,
  name: Label,
  pairedAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The device this connection belongs to. */
  current: Schema.Boolean,
});
export type Device = typeof Device.Type;

/**
 * Crockford base32 without the ambiguous letters, in upper case. Clients
 * upper-case what the operator types and drop spaces and dashes before sending.
 */
const PAIRING_ALPHABET = "0-9A-HJKMNP-TV-Z";
/** Ten characters: 50 bits, against an attacker who gets a handful of tries. */
export const PAIRING_CODE_LENGTH = 10;

/**
 * A one-time code a new client exchanges for a device token, valid for a few
 * minutes. Failed attempts are limited and then locked out (see
 * `docs/architecture/security.md`).
 */
export const PairingCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`)),
).pipe(Schema.brand("PairingCode"));
export type PairingCode = typeof PairingCode.Type;

/** Grants everything the operator can do. The server stores only its hash. */
export const DeviceToken = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(256),
).pipe(Schema.brand("DeviceToken"));
export type DeviceToken = typeof DeviceToken.Type;

/**
 * A single-use credential for opening the RPC socket where the client cannot
 * send an `Authorization` header on a WebSocket upgrade, as in a browser.
 */
export const SocketTicket = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(256),
).pipe(Schema.brand("SocketTicket"));
export type SocketTicket = typeof SocketTicket.Type;
