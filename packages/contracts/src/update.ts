// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { DeviceId, NonNegativeInt, OpenLiterals, PositiveInt, UnknownLiteral } from "./base.ts";

// Updating the server from a client: plain HTTP routes with the device token
// as a bearer, outside `PROTOCOL_VERSION`. A client and a server that no
// longer speak the same protocol cannot open the RPC socket, and one of them
// is behind, so this is how they still read each other's versions and bring
// the server forward. The routes have their own version in their path, and
// their shapes are frozen: a later API version adds paths, never changes these.
// Every set a client receives here is open: a value added after the client was
// built decodes as `unknown`, which a client shows without acting on it.
// docs/decisions/0032-updates-are-served-outside-the-protocol.md says why.

/** The version of the update routes, in their path. Not `PROTOCOL_VERSION`. */
export const UPDATE_API_VERSION = 1;

/**
 * The update routes. Each takes the device token as `Authorization: Bearer`
 * and answers 401 with `NotAuthenticated` without one: every paired device is
 * the operator's. A `POST` body is `Content-Type: application/json`, and any
 * other content type is answered 415 before the body is read, so a web page
 * elsewhere cannot send one without a preflight the server never grants.
 */
export const UPDATE_HTTP_PATHS = {
  /** `GET`. Answers `UpdateStatus`. */
  status: "/api/update/v1/status",
  /**
   * `POST`, no body. Checks the release feed now, at most once a minute,
   * and answers `UpdateStatus` once the check has ended.
   */
  check: "/api/update/v1/check",
  /**
   * `POST` an `UpdateChannelRequest`. Sets the server's channel, the same
   * setting as `Settings.updateChannel`, and answers `UpdateStatus` for it.
   */
  channel: "/api/update/v1/channel",
  /**
   * `POST` an `UpdateStartRequest`. Starts the update to exactly that
   * version, which must be the status' `available` one, and answers 202 with
   * `UpdateStatus`; 409 with `UpdateRefused` when it cannot start.
   */
  start: "/api/update/v1/start",
} as const;

/**
 * A J3 Bots release's version: `0.3.1`, `0.3.1-rc.1`, `0.3.2-nightly.20261124.7`.
 * The server and its clients order them with semantic versioning.
 */
export const ReleaseVersion = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
export type ReleaseVersion = typeof ReleaseVersion.Type;

const UPDATE_CHANNELS = ["stable", "nightly"] as const;

/**
 * Which releases a server is offered. `stable`, the default, is every
 * published release; `nightly` is also each day's build of `main`, a
 * pre-release. A server is never offered a release older than the one it
 * runs, so moving from nightly to stable waits for a stable release newer
 * than the nightly it runs.
 */
export const UpdateChannel = Schema.Literals(UPDATE_CHANNELS);
export type UpdateChannel = typeof UpdateChannel.Type;

const VERIFICATION_FAILURES = [
  "checksums-missing",
  "signature-missing",
  "signature-invalid",
  "checksums-malformed",
  "wrong-release",
  "entry-missing",
  "digest-mismatch",
] as const;

/**
 * Why a release, or a file of one, was refused as unverified. Every release
 * carries `SHA256SUMS`, the SHA-256 of each file it publishes, and
 * `SHA256SUMS.sig`, an Ed25519 signature over it by the project's release key.
 *
 * - `checksums-missing`: the release has no `SHA256SUMS`;
 * - `signature-missing`: the release has no `SHA256SUMS.sig`;
 * - `signature-invalid`: the signature is not one, or not the release key's
 *   over these `SHA256SUMS`;
 * - `checksums-malformed`: the signed `SHA256SUMS` has a line that is not a
 *   digest and a name, a blank line, or a file named twice, or is empty;
 * - `wrong-release`: the signed `SHA256SUMS` is another release's, as a
 *   replay of an older one would be;
 * - `entry-missing`: the file is not listed in it;
 * - `digest-mismatch`: the file's SHA-256 is not the listed one.
 */
export const VerificationFailure = Schema.Literals(VERIFICATION_FAILURES);
export type VerificationFailure = typeof VerificationFailure.Type;

/** A release the feed found on the server's channel. */
export const ReleaseInfo = Schema.Struct({
  version: ReleaseVersion,
  channel: UpdateChannel,
  /** When it was published, as the releases page says. */
  publishedAt: Schema.DateTimeUtc,
  /** Its page, with its notes: what a client opens for "What's new". */
  notesUrl: Schema.String,
  /**
   * Whether its `SHA256SUMS` carries the release key's signature. A server
   * offers only a verified release as `available`, so it is true there.
   */
  verified: Schema.Boolean,
});
export type ReleaseInfo = typeof ReleaseInfo.Type;

const CHECK_FAILURES = ["unreachable", "rate-limited", "unreadable"] as const;

/**
 * Why the last check of the feed did not finish: the releases page could
 * not be reached, it asked to be asked later, or it answered something that
 * is not a list of releases. What the check before it found still stands.
 */
export const ReleaseCheckFailure = Schema.Literals(CHECK_FAILURES);
export type ReleaseCheckFailure = typeof ReleaseCheckFailure.Type;

const INABILITIES = [
  "desktop-managed",
  "started-by-hand",
  "checkout",
  "unpacked",
  "no-systemd",
  "no-linger",
  "rollback-unfinished",
] as const;

/**
 * Why this server cannot update itself from a client:
 *
 * - `desktop-managed`: the desktop app runs it; updating the app updates it;
 * - `started-by-hand`: it was started with `j3-bots serve`, not as a service;
 * - `checkout`: it runs from a source checkout, not an installed release;
 * - `unpacked`: it runs from a release unpacked by hand, which `install.sh`
 *   did not install, so there is no installation to update;
 * - `no-systemd`: there is no user service manager to run the update in;
 * - `no-linger`: the service manager may stop with the last login, and the
 *   update with it;
 * - `rollback-unfinished`: a rollback has not finished, which comes first.
 */
export const UpdateInability = Schema.Literals(INABILITIES);
export type UpdateInability = typeof UpdateInability.Type;

const FAILURES = [
  "health-check",
  "download",
  "verification",
  "engine",
  "disk",
  "interrupted",
  "other",
] as const;

/**
 * Why an update did not end on the new version:
 *
 * - `health-check`: the new version did not become ready in time;
 * - `download`: the release could not be downloaded;
 * - `verification`: what was downloaded did not verify;
 * - `engine`: the new version's engine could not be fetched;
 * - `disk`: there was no room for it;
 * - `interrupted`: the update was cut off, by a restart of the machine or
 *   its service manager;
 * - `other`: anything else `j3-bots update` refuses or fails at, which the
 *   result's `detail` says in words.
 */
export const UpdateFailure = Schema.Literals(FAILURES);
export type UpdateFailure = typeof UpdateFailure.Type;

const OUTCOMES = ["done", "rolled-back", "failed"] as const;

/**
 * How an update ended: `done` on the new version; `rolled-back` to the
 * version before, with its data as it was; `failed`, when even the rollback
 * did not finish and the server needs `j3-bots update --rollback` on its
 * machine.
 */
export const UpdateOutcome = Schema.Literals(OUTCOMES);
export type UpdateOutcome = typeof UpdateOutcome.Type;

const REFUSALS = ["not-available", "busy", "work-running", "unable"] as const;

/**
 * Why `start` refused:
 *
 * - `not-available`: the version is not the feed's verified, newer release
 *   on the server's channel, so nothing was downloaded;
 * - `busy`: an update or a rollback is running;
 * - `work-running`: bots have work running, which the update would stop;
 *   ask the operator, then send `stopWork`;
 * - `unable`: the server cannot update itself (`UpdateStatus.canUpdate`).
 */
export const UpdateRefusal = Schema.Literals(REFUSALS);
export type UpdateRefusal = typeof UpdateRefusal.Type;

/**
 * The open sets of the status, closed as the server writes them or open as a
 * client reads them. One type parameter each, so each keeps its own type.
 */
interface Sets<
  Channel extends Schema.Top,
  Verification extends Schema.Top,
  Check extends Schema.Top,
  Inability extends Schema.Top,
  Failure extends Schema.Top,
  Outcome extends Schema.Top,
> {
  readonly channel: Channel;
  readonly verification: Verification;
  readonly check: Check;
  readonly inability: Inability;
  readonly failure: Failure;
  readonly outcome: Outcome;
}

const STATES = [
  "idle",
  "checking",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "done",
  "rolled-back",
  "failed",
] as const;

const states = <Failure extends Schema.Top>(sets: { readonly failure: Failure }) =>
  [
    /** Nothing is running. */
    Schema.TaggedStruct("idle", {}),
    /** The feed is being checked. */
    Schema.TaggedStruct("checking", {}),
    /** The release is downloading; its size once the download says. */
    Schema.TaggedStruct("downloading", {
      receivedBytes: NonNegativeInt,
      totalBytes: Schema.NullOr(NonNegativeInt),
    }),
    /** What was downloaded is being checked against the signed `SHA256SUMS`. */
    Schema.TaggedStruct("verifying", {}),
    /** The release and its engine are being put in place. */
    Schema.TaggedStruct("installing", {}),
    /** The server is stopping and starting on the new version, then waiting for it to be ready. */
    Schema.TaggedStruct("restarting", {}),
    /** The last update ended on the new version. */
    Schema.TaggedStruct("done", {}),
    /** The last update rolled back. */
    Schema.TaggedStruct("rolled-back", { reason: sets.failure }),
    /** The last update failed, its rollback included. */
    Schema.TaggedStruct("failed", { reason: sets.failure }),
  ] as const;

/**
 * A state added after this build, as a client receives it: some step of an
 * update is running, which the client shows as working.
 */
const UnknownUpdateState = Schema.Struct({ _tag: UnknownLiteral(STATES) }).pipe(
  Schema.decodeTo(Schema.toType(Schema.TaggedStruct("unknown", { kind: Schema.String })), {
    decode: SchemaGetter.transform(({ _tag }: { readonly _tag: string }) => ({
      _tag: "unknown" as const,
      kind: _tag,
    })),
    encode: SchemaGetter.transform(({ kind }: { readonly kind: string }) => ({ _tag: kind })),
  }),
);

const statusOf = <
  Channel extends Schema.Top,
  Verification extends Schema.Top,
  Check extends Schema.Top,
  Inability extends Schema.Top,
  Failure extends Schema.Top,
  Outcome extends Schema.Top,
  State extends Schema.Top,
>(
  sets: Sets<Channel, Verification, Check, Inability, Failure, Outcome>,
  state: State,
) =>
  Schema.Struct({
    /** `UPDATE_API_VERSION` of the server that answered. */
    api: PositiveInt,
    /** What the server runs. */
    current: Schema.Struct({
      version: ReleaseVersion,
      /** The channel its version is published on; null for a release candidate or a build from source. */
      channel: Schema.NullOr(sets.channel),
    }),
    /** The server's channel setting. */
    channel: sets.channel,
    /**
     * The newest release on the channel, newer than `current`, whose
     * `SHA256SUMS` verified: what `start` accepts. Null when there is none,
     * or before the feed was first checked.
     */
    available: Schema.NullOr(Schema.Struct({ ...ReleaseInfo.fields, channel: sets.channel })),
    /**
     * True when the channel is stable and the server runs a pre-release, so
     * it waits for a stable release newer than `current.version`; it is
     * never offered an older one.
     */
    waitingForStable: Schema.Boolean,
    /**
     * A newer release the feed found on the channel and refused, because its
     * `SHA256SUMS` did not verify. Null when the newest one verified.
     */
    refused: Schema.NullOr(Schema.Struct({ version: ReleaseVersion, reason: sets.verification })),
    /** The last check of the feed; null before the first. */
    lastCheck: Schema.NullOr(
      Schema.Struct({
        at: Schema.DateTimeUtc,
        /** Null when the check finished. */
        failure: Schema.NullOr(sets.check),
        /** When the server checks next on its own. */
        nextAt: Schema.DateTimeUtc,
      }),
    ),
    /** Whether this server can update itself from a client, and if not why, with what to do instead. */
    canUpdate: Schema.Union([
      Schema.TaggedStruct("able", {}),
      Schema.TaggedStruct("unable", {
        reason: sets.inability,
        /** A command to run on the server's machine instead, when there is one. */
        command: Schema.NullOr(Schema.String),
      }),
    ]),
    state,
    /**
     * The update under way, from the moment it was asked for until it ends;
     * null otherwise. It outlives the restart in the middle, so a client that
     * reconnects still knows what it waits for.
     */
    run: Schema.NullOr(
      Schema.Struct({
        from: ReleaseVersion,
        to: ReleaseVersion,
        /** The device that asked for it; null when it was started on the server's machine. */
        by: Schema.NullOr(DeviceId),
        startedAt: Schema.DateTimeUtc,
      }),
    ),
    /** How the last update ended; null when the server has never been updated from a client. */
    lastResult: Schema.NullOr(
      Schema.Struct({
        outcome: sets.outcome,
        from: ReleaseVersion,
        to: ReleaseVersion,
        at: Schema.DateTimeUtc,
        /** The device that asked for it; null when it was started on the server's machine. */
        by: Schema.NullOr(DeviceId),
        /** Why it did not end on `to`; null when it did. */
        reason: Schema.NullOr(sets.failure),
        /** What failed, as the server logged it, in English. */
        detail: Schema.NullOr(Schema.String),
      }),
    ),
  });

const KNOWN = {
  channel: UpdateChannel,
  verification: VerificationFailure,
  check: ReleaseCheckFailure,
  inability: UpdateInability,
  failure: UpdateFailure,
  outcome: UpdateOutcome,
} as const;

const RECEIVED = {
  channel: OpenLiterals(UPDATE_CHANNELS),
  verification: OpenLiterals(VERIFICATION_FAILURES),
  check: OpenLiterals(CHECK_FAILURES),
  inability: OpenLiterals(INABILITIES),
  failure: OpenLiterals(FAILURES),
  outcome: OpenLiterals(OUTCOMES),
} as const;

/** Where a server's updates stand, as the server writes it: every value one this build knows. */
export const UpdateState = Schema.Union(states(KNOWN));
export type UpdateState = typeof UpdateState.Type;

/** Where a server's updates stand, as the server writes it. */
export const UpdateStatus = statusOf(KNOWN, UpdateState);
export type UpdateStatus = typeof UpdateStatus.Type;

/** An update's state as a client receives it: a state, a reason or a channel it does not know is `unknown`. */
export const ReceivedUpdateState = Schema.Union([...states(RECEIVED), UnknownUpdateState]);
export type ReceivedUpdateState = typeof ReceivedUpdateState.Type;

/** `UpdateStatus` as a client receives it, from a server of any version. */
export const ReceivedUpdateStatus = statusOf(RECEIVED, ReceivedUpdateState);
export type ReceivedUpdateStatus = typeof ReceivedUpdateStatus.Type;

export const UpdateChannelRequest = Schema.Struct({ channel: UpdateChannel });
export type UpdateChannelRequest = typeof UpdateChannelRequest.Type;

export const UpdateStartRequest = Schema.Struct({
  /** Exactly the status' `available.version`: never a tag such as `latest`. */
  version: ReleaseVersion,
  /**
   * Whether to stop the bots' running work. Without it, a server with work
   * running refuses with `work-running`, and the client asks the operator.
   */
  stopWork: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type UpdateStartRequest = typeof UpdateStartRequest.Type;

const refusal = {
  /** With `work-running`, how many bots have work running; null otherwise. */
  runningBots: Schema.NullOr(PositiveInt),
};

/** `start`'s 409, as the server writes it. */
export class UpdateRefused extends Schema.TaggedError<UpdateRefused>()("UpdateRefused", {
  reason: UpdateRefusal,
  ...refusal,
}) {
  override get message(): string {
    return `The update was refused: ${this.reason}.`;
  }
}

/** `start`'s 409 as a client receives it: a reason it does not know is `unknown`. */
export const ReceivedUpdateRefused = Schema.TaggedStruct("UpdateRefused", {
  reason: OpenLiterals(REFUSALS),
  ...refusal,
});
export type ReceivedUpdateRefused = typeof ReceivedUpdateRefused.Type;
