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
  /**
   * The device registered for push notifications (`push.register`): the server
   * pushes to it while it has no socket open.
   */
  pushRegistered: Schema.Boolean,
});
export type Device = typeof Device.Type;

/** The languages the interface is written in, and a push to a device can be. */
export const LANGUAGES = ["en", "pt-BR"] as const;
export const Language = Schema.Literals(LANGUAGES);
export type Language = typeof Language.Type;

/** The push services a device can register with. Expo's is the only one so far. */
export const PushProvider = Schema.Literal("expo");
export type PushProvider = typeof PushProvider.Type;

export const PushPlatform = Schema.Literals(["ios", "android"]);
export type PushPlatform = typeof PushPlatform.Type;

/** The longest `PushToken`. Expo's tokens are a few dozen characters. */
export const MAX_PUSH_TOKEN_LENGTH = 256;

/**
 * The address a push service gives an installed app, such as
 * `ExponentPushToken[…]`: printable ASCII with no spaces. It lets whoever holds
 * it send that app a notification through the service, so it is kept like the
 * rest of the operator's data and never shown.
 */
export const PushToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PUSH_TOKEN_LENGTH),
  Schema.isPattern(/^[\x21-\x7e]+$/),
).pipe(Schema.brand("PushToken"));
export type PushToken = typeof PushToken.Type;

/** Where and how to push to a device: the service, its token, and the language to write in. */
export const PushRegistration = Schema.Struct({
  provider: PushProvider,
  token: PushToken,
  platform: PushPlatform,
  /** The language the device shows its interface in, which a push to it is written in. */
  language: Language,
});
export type PushRegistration = typeof PushRegistration.Type;

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
