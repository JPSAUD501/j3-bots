// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DeviceId, Label, PositiveInt } from "./base.ts";
import { DeviceToken, PairingCode, SocketTicket } from "./device.ts";

// What a client does over plain HTTP: everything it needs before it holds a
// device token, the exchange for a socket ticket, and file bytes. Bodies are
// JSON unless noted; a failure answers with the error's encoded form and the
// status given below.

/**
 * Bumped when a change to the contract would break a client built against the
 * previous version. Clients compare it with `GET /api/server` before anything
 * else. 6 is the first whose clients pass over a kind of entry or notice, or a
 * failure class, they do not know: from 6 on, adding one needs no bump. 7
 * widened the avatars a client sends to twelve shapes and twelve colors. 8
 * added the bot's browser: `browser.subscribe` and the media socket at
 * `HTTP_PATHS.browser`. 9 added teammate conversations (`TeammatePairRpcs`). 10 took the host
 * and the hop limit out of a room: `Room`, `room.create` and `room.update`
 * have neither `hostId` nor `hopLimit`, and a room's bots go quiet past a
 * fixed limit since the operator last wrote there (`chain-stopped` with
 * `limit: "room"`). 11 is 0.9.0's, once for all its changes: the skills
 * (`SkillRpcs`), who changed a connector last (`Connector.lastChange`), no
 * connector suggestion card, and the vault became secrets (`SecretsRpcs` in
 * place of the vault's requests, the `secret-ask` card in place of the
 * save-login card, no `Bot.vault`).
 * docs/architecture/clients.md, "Protocol compatibility", says what does.
 */
export const PROTOCOL_VERSION = 11;

export const HTTP_PATHS = {
  /** `GET`, no credential. Answers `ServerInfo`. */
  server: "/api/server",
  /**
   * `POST` a `PairRequest` as `Content-Type: application/json`, no credential.
   * Answers `PairResult`; 400 with `Invalid("pairing-code")` for a wrong or
   * expired code, 429 with `RateLimited` while pairing is locked out. Any other
   * content type is answered 415 before the body is read, and does not count
   * as an attempt: a web page can send `text/plain` anywhere without asking,
   * but not JSON to another origin.
   */
  pair: "/api/pair",
  /**
   * `POST` with the device token as `Authorization: Bearer`. Answers
   * `SocketTicketGrant`; 401 with `NotAuthenticated` when the device is not
   * paired or was revoked, which means pair again.
   */
  socketTicket: "/api/socket-ticket",
  /**
   * `POST` the raw bytes with the file's media type as `Content-Type` and its name
   * in the `name` query parameter, with the device token as a bearer. Answers the
   * new `Attachment`, whose name is trimmed and whose media type is lowercased
   * without parameters; 413 above `MAX_ATTACHMENT_SIZE`, 400 with
   * `Invalid("attachment")` for an empty body, a name that is blank or over
   * `MAX_ATTACHMENT_NAME_LENGTH` characters, or a media type that is not
   * `type/subtype` within 100 characters, and 409 with `Conflict("private-location")`,
   * storing nothing, when the server's attachments folder has been linked out
   * of its private data. Uploading the same bytes again gives
   * a new attachment with its own name; the bytes are stored once.
   * `GET <path>/<id>` answers the bytes, with the same credential.
   */
  attachments: "/attachments",
  /**
   * The RPC socket (`J3Rpcs`, JSON frames). The upgrade carries the device token
   * as `Authorization: Bearer`, or a ticket in the `ticket` query parameter. An
   * upgrade without a valid one is answered 401 and never becomes a socket.
   */
  rpc: "/ws",
  /**
   * The media socket for one tab of a bot's browser: pictures of the page as
   * binary JPEG messages, and `BrowserServerFrame` and `BrowserClientFrame`
   * as JSON text. The upgrade carries the device token as a bearer or a
   * ticket, as the RPC socket's does, and `BrowserViewQuery`. An upgrade
   * without a valid credential is answered 401; one for a tab that is gone
   * becomes a socket that sends `gone` and closes, since a browser cannot
   * read why an upgrade was refused. `BROWSER_CLOSE_CODES` lists the rest.
   */
  browser: "/api/browser/ws",
} as const;

/**
 * The origins the desktop app's pages have: its bundled web client is served
 * from a custom scheme and calls the server across origins, so the server
 * answers CORS for these and no others. No web page can send either `Origin`.
 * The names are development placeholders until the project's name and ids are
 * settled.
 */
export const DESKTOP_APP_ORIGINS = {
  production: "j3bots://app",
  development: "j3bots-dev://app",
} as const;

export const ServerInfo = Schema.Struct({
  protocolVersion: PositiveInt,
  /** The J3 Bots release. */
  version: Label,
  startedAt: Schema.DateTimeUtc,
  /**
   * The `UPDATE_API_VERSION` of the update routes the server serves
   * (`UPDATE_HTTP_PATHS`), outside the protocol; null from a server that
   * has none. A client offers to update the server only when it is set.
   */
  updateApi: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type ServerInfo = typeof ServerInfo.Type;

export const PairRequest = Schema.Struct({
  code: PairingCode,
  /**
   * What the operator will see in the device list, such as "Pixel 9". A native
   * client offers its platform's name for the device; the operator can change it.
   */
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
