// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { DeviceId, Label, PositiveInt } from "./base.ts";
import { DeviceToken, PairingCode, SocketTicket } from "./device.ts";

// What a client does over plain HTTP: everything it needs before it holds a
// device token, the exchange for a socket ticket, and file bytes. Bodies are
// JSON unless noted; a failure answers with the error's encoded form and the
// status given below.

/**
 * Bumped when a change to the contract would break a client built against the
 * previous version. Clients compare it with `GET /api/server` before anything else.
 */
export const PROTOCOL_VERSION = 1;

export const HTTP_PATHS = {
  /** `GET`, no credential. Answers `ServerInfo`. */
  server: "/api/server",
  /**
   * `POST` a `PairRequest`, no credential. Answers `PairResult`; 400 with
   * `Invalid("pairing-code")` for a wrong or expired code, 429 with `RateLimited`
   * while pairing is locked out.
   */
  pair: "/api/pair",
  /** `POST` with the device token as `Authorization: Bearer`. Answers `SocketTicketGrant`. */
  socketTicket: "/api/socket-ticket",
  /**
   * `POST` the raw bytes with the file's media type as `Content-Type` and its name
   * in the `name` query parameter, with the device token as a bearer. Answers the
   * new `Attachment`; 413 above `MAX_ATTACHMENT_SIZE`.
   * `GET <path>/<id>` answers the bytes, with the same credential.
   */
  attachments: "/attachments",
  /**
   * The RPC socket (`J3Rpcs`, JSON frames). The upgrade carries the device token
   * as `Authorization: Bearer`, or a ticket in the `ticket` query parameter. An
   * upgrade without a valid one is answered 401 and never becomes a socket.
   */
  rpc: "/ws",
} as const;

export const ServerInfo = Schema.Struct({
  protocolVersion: PositiveInt,
  /** The J3 Bots release. */
  version: Label,
  startedAt: Schema.DateTimeUtc,
});
export type ServerInfo = typeof ServerInfo.Type;

export const PairRequest = Schema.Struct({
  code: PairingCode,
  /** What the operator will see in the device list, such as "Pixel 9". */
  name: Label,
});
export type PairRequest = typeof PairRequest.Type;

export const PairResult = Schema.Struct({ deviceId: DeviceId, token: DeviceToken });
export type PairResult = typeof PairResult.Type;

/** Valid for one upgrade, within a minute. */
export const SocketTicketGrant = Schema.Struct({
  ticket: SocketTicket,
  expiresAt: Schema.DateTimeUtc,
});
export type SocketTicketGrant = typeof SocketTicketGrant.Type;
