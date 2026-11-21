// SPDX-License-Identifier: AGPL-3.0-or-later
import { EngineStatus, PairingCode, ServerOrigin } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// What `j3-bots` commands ask the running server over its admin socket
// (`<J3_HOME>/admin.sock`). Only this package speaks it: the CLI and the
// server are one program, so it is not a client contract.

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
   * `POST`, a `ProviderConnectionRequest`. Answers a `ProviderConnectionOutcome`
   * once the engine restarted with the connection, or it could not.
   */
  providerConnection: "/provider-connection",
  /** `GET`. Answers `RunningWorkReply`: what `j3-bots update` would stop. */
  runningWork: "/running-work",
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

/**
 * What `j3-bots provider connect` does beyond storing the connection, as the
 * command's help and `doctor` both say it.
 */
export const CONNECT_RESTARTS =
  "It restarts the engine so the connection applies at once. A restart stops the work bots have running, so when any has, it asks first; `--yes` answers for you.";

/** Hosts that never leave the machine: plain HTTP to them sends the key nowhere. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * A URL's base form: its origin and its path, as the URL parser writes them
 * (lower-case host, no default port, dot segments resolved, tabs and line
 * breaks dropped), with no `/` for an empty path.
 */
export const baseUrlForm = (url: URL) => `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;

/**
 * Why `text` is not an endpoint's base URL as the engine is given it, or
 * undefined when it is one: `https`, or `http` to a loopback host only, since
 * the key travels with every request in clear otherwise; no credentials,
 * query or fragment, not even an empty `?` or `#`, which the parser drops but
 * a harness would append its path after, since the base URL is kept in plain
 * text and the key travels on its own; no trailing `/` or `/v1`, which each
 * harness adds itself; and written in its base form (`baseUrlForm`), so the
 * text the engine is given is the URL that was checked. A problem never
 * repeats the text, which may hold a credential.
 */
export const providerBaseUrlProblem = (text: string): string | undefined => {
  if (!URL.canParse(text) || text.length > 1000) return "it is not a URL";
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "it is not an http or https URL";
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return "plain http would send the key in clear to another machine; use https, or http only to this machine (localhost, 127.0.0.1 or [::1])";
  }
  if (url.username !== "" || url.password !== "") return "it carries a user name or password";
  if (text.includes("?") || text.includes("#")) return "it has a query or fragment";
  if (text.endsWith("/") || url.pathname.endsWith("/v1")) return "it ends in / or /v1";
  if (baseUrlForm(url) !== text) {
    return "it is not written as scheme://host[:port][/path], in lower case, without a default port or . and .. segments";
  }
  return undefined;
};

export const ProviderConnectionRequest = Schema.Struct({
  baseUrl: Schema.String.check(
    Schema.makeFilter((text) => providerBaseUrlProblem(text) === undefined, {
      expected: "an https base URL, or an http one to this machine",
    }),
  ),
  /** Sent over the private admin socket only, and never logged. */
  key: Schema.NonEmptyString,
  /**
   * Whether the operator agreed that the engine's restart stops the work
   * bots have running. Without it, the server stores nothing while any runs.
   */
  stopWork: Schema.Boolean,
});
export type ProviderConnectionRequest = typeof ProviderConnectionRequest.Type;

/** What became of the request (`Engine.connectProviders`). */
export const ProviderConnectionOutcome = Schema.Union([
  /** Stored, and the engine restarted with it. */
  Schema.TaggedStruct("applied", { baseUrl: Schema.String }),
  /** Stored, and the engine is not back yet: it starts with it. */
  Schema.TaggedStruct("stored", { baseUrl: Schema.String }),
  /**
   * Nothing stored: `bots` bots have work running, which the restart would
   * stop, and the request did not agree to that.
   */
  Schema.TaggedStruct("work-running", { bots: Schema.Int.check(Schema.isGreaterThan(0)) }),
  /** Not stored: the one before it, if any, stays in force. */
  Schema.TaggedStruct("refused", { active: Schema.NullOr(Schema.String) }),
]);
export type ProviderConnectionOutcome = typeof ProviderConnectionOutcome.Type;
