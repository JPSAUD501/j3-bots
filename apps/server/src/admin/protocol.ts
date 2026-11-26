// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, EngineStatus, Label, PairingCode, ServerOrigin } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// What `j3-bots` commands, and the desktop app that runs its own server, ask
// the running server over its admin channel: the socket in the home
// (`<J3_HOME>/admin.sock`), or the pipe the server inherited from the process
// that started it (`j3-bots serve --admin-fd`). Both serve the same routes.
// Only J3 Bots' own programs speak it, and a server always ships with the CLI
// and the desktop app that talk to it, so it is not a client contract.

export const ADMIN_PATHS = {
  /** `GET`. Answers `AdminStatus`. */
  status: "/status",
  /**
   * `POST`, no body. Answers a `PairingOffer`: a fresh code for a new device,
   * or, while pairing is locked after failed attempts, until when, and no code.
   */
  pairing: "/pairing",
  /** `POST`, no body. Lifts a lock on pairing, then answers as `pairing` does. */
  unlockPairing: "/pairing/unlock",
  /**
   * `POST`, a `ProviderConnectionRequest` (from `@j3-bots/contracts`, as
   * `provider.connect` takes it). Answers a `ProviderConnectionOutcome`
   * once the engine restarted with the connection, or it could not.
   */
  providerConnection: "/provider-connection",
  /**
   * `POST`, no body. Answers `RunningWorkReply`: what `j3-bots update` would
   * stop, right before it stops the service. Read with every new first send
   * held; when no work runs, they stay held until the server stops, or for
   * `IDLE_HOLD` if it does not, so no work begins before the stop.
   */
  runningWork: "/running-work",
  /**
   * `POST`, a `LocalDeviceRequest`. Pairs a device without a code, as a
   * successful pairing does, and answers its `PairResult`. In the same
   * transaction it revokes the device the request replaces. 400 when the body
   * does not decode. How the desktop app gets its own device; it never exists
   * on the client listener.
   */
  localDevice: "/local-device",
  /**
   * `POST`, no body. Answers 202, then stops the server as SIGTERM does. How
   * a parent stops it where there is no SIGTERM, on Windows.
   */
  shutdown: "/shutdown",
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
  /**
   * The `publicOrigin` the server runs with, absent when none is set. Optional
   * so that a command reads the status of a server from before the setting.
   */
  publicOrigin: Schema.optionalKey(ServerOrigin),
  /**
   * The origins another device reaches the server at, best first, as
   * `j3-bots pair` lists them: read from the interfaces as the status is
   * asked, since addresses come and go. Optional so that a command reads the
   * status of a server from before it.
   */
  origins: Schema.optionalKey(Schema.Array(ServerOrigin)),
  /**
   * The names the client listener refused over plain HTTP since it started,
   * the first few (`RefusedNames`): a proxy or tunnel that serves the server
   * under one of them needs `publicOrigin`. Optional so that a command reads
   * the status of a server from before it.
   */
  refusedNames: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AdminStatus = typeof AdminStatus.Type;

/**
 * The part of the status reply `j3-bots update` waits on: a server of the new
 * release, the service's own process, with its engine ready. It decodes only
 * these fields, and the engine's state by its tag alone, so it reads the reply
 * of a release newer than itself, which only adds to it.
 */
export const ServerReadiness = Schema.Struct({
  version: Schema.String,
  pid: Schema.Int,
  engine: Schema.Struct({ state: Schema.Struct({ _tag: Schema.String }) }),
});
export type ServerReadiness = typeof ServerReadiness.Type;

export const RunningWorkReply = Schema.Struct({
  /** How many bots have work running in the engine, which a stop of the server stops. */
  bots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RunningWorkReply = typeof RunningWorkReply.Type;

export const PairingOffer = Schema.Union([
  Schema.TaggedStruct("granted", { code: PairingCode, expiresAt: Schema.DateTimeUtc }),
  /** No code: one made now could not pair before `until`. */
  Schema.TaggedStruct("locked", { until: Schema.DateTimeUtc }),
]);
export type PairingOffer = typeof PairingOffer.Type;

export const LocalDeviceRequest = Schema.Struct({
  /** What the device list shows, as a pairing device's name. */
  name: Label,
  /**
   * The device this one takes the place of, such as the one the desktop app
   * kept before, revoked with the new one's pairing. An id that is unknown or
   * already revoked is left as it is.
   */
  replaces: Schema.NullOr(DeviceId),
});
export type LocalDeviceRequest = typeof LocalDeviceRequest.Type;

/**
 * What `j3-bots provider connect` does beyond storing the connection, as the
 * command's help and `doctor` both say it.
 */
export const CONNECT_RESTARTS =
  "It restarts the engine so the connection applies at once. A restart stops the work bots have running, so when any has, it asks first; `--yes` answers for you.";
