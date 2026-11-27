// SPDX-License-Identifier: AGPL-3.0-or-later
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./base.ts";
import { FailureClass } from "./bot.ts";
import { Conflict, Invalid, NotFound, SecretRefused } from "./errors.ts";
import { ReleaseVersion, UpdateFailure } from "./update.ts";

// Anonymous usage data (docs/decisions/0099-usage-data-is-the-servers-typed-and-on-until-turned-off.md).
// The server sends it; clients send their few events to their server, never
// anywhere else. Every event and every property is declared here, with closed
// literal sets, numbers, booleans and version strings, so nothing a person
// wrote, named or owns can be one: no text, no names, no ids of bots, rooms
// or conversations, no paths, addresses or secrets.

/**
 * The SHA-256 of a random id, in lowercase hex: how the server's install
 * and each client device are told apart. The random id itself never leaves
 * the machine that made it, and none is ever derived from a person, an
 * account, a machine's name or a path.
 */
export const TelemetryIdHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TelemetryIdHash"),
);
export type TelemetryIdHash = typeof TelemetryIdHash.Type;

/** The one hash every side uses, so the server and the clients agree. */
export const telemetryIdHash = (randomId: string): TelemetryIdHash =>
  TelemetryIdHash.make(bytesToHex(sha256(utf8ToBytes(randomId))));

/** Where a client runs: the browser, the desktop app's window, its quick access, the Android app. */
export const TelemetrySurface = Schema.Literals(["web", "desktop", "quick-access", "android"]);
export type TelemetrySurface = typeof TelemetrySurface.Type;

/** An operating system's family. A version or a distribution is never sent. */
export const TelemetryOs = Schema.Literals([
  "linux",
  "macos",
  "windows",
  "android",
  "ios",
  "other",
]);
export type TelemetryOs = typeof TelemetryOs.Type;

export const TelemetryArch = Schema.Literals(["x64", "arm64", "other"]);
export type TelemetryArch = typeof TelemetryArch.Type;

/**
 * How the server runs:
 * - `service`: installed with `install.sh`, run by its service;
 * - `desktop`: the desktop app runs it on its own computer;
 * - `manual`: a release started by hand, or unpacked outside `install.sh`'s folder;
 * - `development`: a source checkout, which sends only when told to.
 */
export const TelemetryInstallKind = Schema.Literals([
  "service",
  "desktop",
  "manual",
  "development",
]);
export type TelemetryInstallKind = typeof TelemetryInstallKind.Type;

/** A count in a bucket, where the exact number could tell one install from another. */
export const CountBucket = Schema.Literals(["0", "1", "2-3", "4-10", "11+"]);
export type CountBucket = typeof CountBucket.Type;

export const countBucket = (count: number): CountBucket =>
  count <= 0 ? "0" : count === 1 ? "1" : count <= 3 ? "2-3" : count <= 10 ? "4-10" : "11+";

/** A version as J3 Bots, its engine or a client numbers it. */
export const TelemetryVersion = ReleaseVersion;

/** What a client tells its server about itself once its socket opens (`telemetry.hello`). */
export const TelemetryClient = Schema.Struct({
  surface: TelemetrySurface,
  version: TelemetryVersion,
  os: TelemetryOs,
  /** The hash of a random id this client keeps for itself. */
  device: TelemetryIdHash,
});
export type TelemetryClient = typeof TelemetryClient.Type;

/** A whole number of seconds or tokens: what a measurement sends, never a fraction. */
export const TelemetryCount = NonNegativeInt;

/** The harness a bot runs on. */
export const TelemetryHarness = Schema.Literals(["claude-code", "codex", "other"]);
export type TelemetryHarness = typeof TelemetryHarness.Type;

/**
 * A model as the engine's catalog names it, such as `claude-opus-4-5` or
 * `gpt-5.4`, or `custom` for any other: a model id the engine does not list
 * can name a person, a deployment or a file. The server sends one only after
 * finding it in its harness's catalog.
 */
export const TelemetryModel = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]*$/),
).pipe(Schema.brand("TelemetryModel"));
export type TelemetryModel = typeof TelemetryModel.Type;

/** A reasoning effort the engine names, `default` for the harness's own, `other` for any other. */
export const TelemetryEffort = Schema.Literals([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "other",
]);
export type TelemetryEffort = typeof TelemetryEffort.Type;

/**
 * What woke the bot for a turn: the operator in its conversation, a room, a
 * routine, a routine a connector's event started, a teammate, or anything
 * else (work handed back to it, J3 Bots itself).
 */
export const TelemetryTurnOrigin = Schema.Literals([
  "conversation",
  "room",
  "routine",
  "event",
  "teammate",
  "other",
]);
export type TelemetryTurnOrigin = typeof TelemetryTurnOrigin.Type;

/** How a turn ended. */
export const TelemetryTurnOutcome = Schema.Literals(["completed", "failed", "stopped"]);
export type TelemetryTurnOutcome = typeof TelemetryTurnOutcome.Type;

/** Where a connector comes from: J3 Bots' catalog, or an address the operator gave. */
export const TelemetryConnectorSource = Schema.Literals(["catalog", "custom"]);
export type TelemetryConnectorSource = typeof TelemetryConnectorSource.Type;

/** How a connector's app is shown. */
export const TelemetryDisplayMode = Schema.Literals(["inline", "fullscreen", "pip"]);
export type TelemetryDisplayMode = typeof TelemetryDisplayMode.Type;

/**
 * A feature a client tells its server was used, which no request to the
 * server shows: What's new opened, and a message dictated. Screen recording
 * joins the list when it reaches J3 Bots.
 */
export const TelemetryFeature = Schema.Literals(["whats-new", "voice-input"]);
export type TelemetryFeature = typeof TelemetryFeature.Type;

// ---------------------------------------------------------------------------
// Events

/** What every event the server sends carries, beside its own properties. */
const SERVER_PROPERTIES = {
  /** The hash of the install's random id; also the event's `distinct_id`. */
  installId: TelemetryIdHash,
  /** No person profile is made for the install. */
  $process_person_profile: Schema.Literal(false),
  /** No place is looked up from the address the batch came from. */
  $geoip_disable: Schema.Literal(true),
  j3Version: TelemetryVersion,
  /** Null until the engine's version is known. */
  engineVersion: Schema.NullOr(TelemetryVersion),
  os: TelemetryOs,
  arch: TelemetryArch,
  installKind: TelemetryInstallKind,
} as const;

/** What an event a client's request caused carries about that client (`telemetry.hello`). */
const CLIENT_PROPERTIES = {
  surface: Schema.optionalKey(TelemetrySurface),
  clientVersion: Schema.optionalKey(TelemetryVersion),
  clientOs: Schema.optionalKey(TelemetryOs),
  clientDevice: Schema.optionalKey(TelemetryIdHash),
} as const;

const Uuid = Schema.String.check(Schema.isUUID());

/**
 * An event: its name and its own properties, as the server records it, and
 * as it leaves: in PostHog's batch format, with every property it carries.
 */
const event = <const Name extends string, const Fields extends Schema.Struct.Fields>(
  name: Name,
  fields: Fields,
) => ({
  recorded: Schema.Struct({ event: Schema.Literal(name), properties: Schema.Struct(fields) }),
  sent: Schema.Struct({
    uuid: Uuid,
    event: Schema.Literal(name),
    distinct_id: TelemetryIdHash,
    timestamp: Schema.DateTimeUtc,
    properties: Schema.Struct({ ...fields, ...SERVER_PROPERTIES, ...CLIENT_PROPERTIES }),
  }),
});

/** The server started. Answers which versions, systems and kinds of install are in use. */
const ServerStarted = event("server.started", {});

/** A client opened its connection, at most once a day per client device. Answers which surfaces and app versions are used. */
const ClientConnected = event("client.connected", {});

/** The install ran today, once a UTC day, with its size in buckets. Answers how many installs are active and how big they grow. */
const InstallActive = event("install.active", {
  bots: CountBucket,
  rooms: CountBucket,
  routines: CountBucket,
  connectors: CountBucket,
});

/**
 * A bot's turn ended. Answers which harnesses, models and efforts run, where
 * turns come from, how they end and how long they take. The model and the
 * effort are the bot's as the turn ended. The engine reports no token counts
 * to J3 Bots, so none are sent.
 */
const TurnFinished = event("turn.finished", {
  harness: TelemetryHarness,
  model: TelemetryModel,
  effort: TelemetryEffort,
  origin: TelemetryTurnOrigin,
  outcome: TelemetryTurnOutcome,
  /** Why it failed, when it did. */
  failure: Schema.NullOr(FailureClass),
  durationSeconds: TelemetryCount,
});

/** The operator sent a message. Active use is counted from these, and the features a message used. */
const MessageSent = event("message.sent", {
  place: Schema.Literals(["conversation", "room"]),
  mention: Schema.Boolean,
  reply: Schema.Boolean,
  quote: Schema.Boolean,
  attachments: Schema.Boolean,
});

/** Who made a bot or a room: the operator, or a bot with its tools. */
export const TelemetryMaker = Schema.Literals(["operator", "bot"]);

/** A bot was made. Answers which harnesses people start with, whether templates help, and how often bots make bots. */
const BotCreated = event("bot.created", {
  harness: TelemetryHarness,
  fromTemplate: Schema.Boolean,
  by: TelemetryMaker,
});

/** A room was made. Answers how big rooms are, and who starts them. */
const RoomCreated = event("room.created", { members: CountBucket, by: TelemetryMaker });

/**
 * A routine's run ended: it said something, finished silently, failed, was
 * skipped as the one before still ran, or was stopped. Answers whether
 * routines do their job.
 */
const RoutineRan = event("routine.ran", {
  outcome: Schema.Literals(["delivered", "silent", "failed", "skipped", "stopped"]),
});

/**
 * A connector was added to J3 Bots. Answers which kinds people connect.
 * Whether it has an app is known only once its server lists its tools.
 */
const ConnectorAdded = event("connector.added", { source: TelemetryConnectorSource });

/** A connector was removed. Answers which kinds people give up on. */
const ConnectorRemoved = event("connector.removed", {
  source: TelemetryConnectorSource,
  hasApp: Schema.Boolean,
});

/** A client showed a connector's app. Answers how apps are looked at. */
const ConnectorAppShown = event("connector-app.shown", { displayMode: TelemetryDisplayMode });

/**
 * An update of the server ended: the server now runs another release, or an
 * update a client started was rolled back or failed, and why. Answers
 * whether updates work.
 */
const UpdateApplied = event("update.applied", {
  from: TelemetryVersion,
  to: TelemetryVersion,
  outcome: Schema.Literals(["updated", "rolled-back", "failed"]),
  failure: Schema.NullOr(UpdateFailure),
});

/** A client used a feature no request to the server shows. */
const FeatureUsed = event("feature.used", { feature: TelemetryFeature });

/**
 * A client's request failed with an error the contract names, which the
 * client shows: its tag and its code, never its text. Answers which errors
 * people meet, and how often.
 */
const RequestFailed = event("request.failed", {
  error: Schema.Literals(["NotFound", "Conflict", "Invalid", "SecretRefused", "other"]),
  code: Schema.NullOr(
    Schema.Union([
      NotFound.fields.resource,
      Conflict.fields.reason,
      Invalid.fields.reason,
      SecretRefused.fields.problem,
    ]),
  ),
});

const EVENTS = [
  ServerStarted,
  ClientConnected,
  InstallActive,
  TurnFinished,
  MessageSent,
  BotCreated,
  RoomCreated,
  RoutineRan,
  ConnectorAdded,
  ConnectorRemoved,
  ConnectorAppShown,
  UpdateApplied,
  FeatureUsed,
  RequestFailed,
] as const;

/** An event the server records: its name and its own properties. */
export const TelemetryEvent = Schema.Union(EVENTS.map((each) => each.recorded));
export type TelemetryEvent = typeof TelemetryEvent.Type;

/** The events a client sends its server (`telemetry.record`); the server sends every other itself. */
export const ClientTelemetryEvent = Schema.Union([
  ConnectorAppShown.recorded,
  FeatureUsed.recorded,
]);
export type ClientTelemetryEvent = typeof ClientTelemetryEvent.Type;

/** An event as it left the server, every property it carried: what "See what is sent" shows. */
export const SentTelemetryEvent = Schema.Union(EVENTS.map((each) => each.sent));
export type SentTelemetryEvent = typeof SentTelemetryEvent.Type;

/** How many sent events `telemetry.sent` returns at most: the newest. */
export const MAX_SENT_TELEMETRY_EVENTS = 100;

/**
 * The switch in Settings, and whether the server's environment keeps usage
 * data off whatever it says (`DO_NOT_TRACK`, `J3_TELEMETRY_ENABLED=false`, a
 * CI runner or a source checkout). Data is sent only while `enabled` and not
 * `heldOff`.
 */
export const TelemetrySetting = Schema.Struct({
  enabled: Schema.Boolean,
  heldOff: Schema.Boolean,
});
export type TelemetrySetting = typeof TelemetrySetting.Type;
