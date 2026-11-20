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

export const AdminStatus = Schema.Struct({
  /** The J3 Bots release that is running. */
  version: Schema.String,
  startedAt: Schema.DateTimeUtc,
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
