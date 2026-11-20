// SPDX-License-Identifier: AGPL-3.0-or-later
import { EngineStatus, PairingCode } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// What `j3-bots` commands ask the running server over its admin socket
// (`<J3_HOME>/admin.sock`). Only this package speaks it: the CLI and the
// server are one program, so it is not a client contract.

export const ADMIN_PATHS = {
  /** `GET`. Answers `AdminStatus`. */
  status: "/status",
  /** `POST`, no body. Answers a `PairingGrant`: a fresh code for a new device. */
  pairing: "/pairing",
} as const;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));

/** Where the running server listens for clients, as it bound it. */
export const ListenerStatus = Schema.Struct({
  scheme: Schema.Literals(["http", "https"]),
  /** The address bound: one IP address, or `0.0.0.0` for every IPv4 interface. */
  address: Schema.String,
  port: Port,
  /** With HTTPS, the DNS names the certificate covers, wildcards left out: the names clients open. */
  names: Schema.Array(Schema.String),
});
export type ListenerStatus = typeof ListenerStatus.Type;

export const AdminStatus = Schema.Struct({
  /** The J3 Bots release that is running. */
  version: Schema.String,
  /** The server's process id, which tells it from another process on the same socket. */
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Schema.DateTimeUtc,
  listener: ListenerStatus,
  /** The loopback port of the bot tool endpoint. */
  toolPort: Port,
  /** The loopback port the engine is run on. */
  enginePort: Port,
  engine: EngineStatus,
  /** Devices paired and not revoked. */
  pairedDevices: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether the server found a built web client to serve when it started. */
  webClient: Schema.Literals(["served", "not-built"]),
});
export type AdminStatus = typeof AdminStatus.Type;

export const PairingGrant = Schema.Struct({
  code: PairingCode,
  expiresAt: Schema.DateTimeUtc,
});
export type PairingGrant = typeof PairingGrant.Type;
