import * as Schema from "effect/Schema";
import { DeviceId, Label } from "./base.ts";

/** A paired client. */
export const Device = Schema.Struct({
  id: DeviceId,
  name: Label,
  pairedAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The device making this request. */
  current: Schema.Boolean,
});
export type Device = typeof Device.Type;

/** A short code a new client exchanges for a device token. Valid once, for a few minutes. */
export const PairingCode = Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32)).pipe(
  Schema.brand("PairingCode"),
);
export type PairingCode = typeof PairingCode.Type;

/** Grants everything the operator can do. The server stores only its hash. */
export const DeviceToken = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(256),
).pipe(Schema.brand("DeviceToken"));
export type DeviceToken = typeof DeviceToken.Type;
