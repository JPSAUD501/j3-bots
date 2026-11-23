// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  NonNegativeInt,
  ReleaseCheckFailure,
  ReleaseVersion,
  type UpdateChannel,
  UpdateChannel as UpdateChannelSchema,
  type UpdateStatus,
  VerificationFailure,
} from "@j3-bots/contracts";
import {
  channelOf,
  GitHubRelease,
  GitHubReleases,
  isNewer,
  newestOn,
  offer,
  releaseTag,
  SIGNATURE_FILE,
  SUMS_FILE,
  verifySums,
} from "@j3-bots/release";
import { signatureCheck } from "@j3-bots/release/node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import packageJson from "../../package.json" with { type: "json" };
import { releaseBase } from "../install/release.ts";
import { Layout } from "../Layout.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { trustedReleaseKeys } from "./keys.ts";

// Which newer release this server is offered, checked against its signature
// (docs/architecture/server.md, "Release feed"). It reads GitHub's REST API
// for the repository's releases, without a token: `releases/latest` for the
// stable channel, `releases?per_page=30` for nightly: one request a check,
// of the 60 an hour GitHub allows an address without a token. Each is
// conditional, with the last answer's ETag, so an unchanged list is a 304
// with nothing to decode (it still counts against the limit). A release
// is available only once its `SHA256SUMS.sig` verifies and only when it is
// newer than the running one: never a downgrade.
//
// What it found is kept in `<home>/state/release-feed.json`, so a restart,
// an update's included, neither asks again before the check is due nor
// verifies a release again.

const REPOSITORY_API = "https://api.github.com/repos/JPSAUD501/j3-bots";

/**
 * GitHub's API for the repository's releases, or a test's or a mirror's
 * stand-in that answers `<base>/releases/latest` and `<base>/releases`:
 * `J3_RELEASE_FEED_URL`. Its releases are then downloaded from
 * `J3_RELEASE_BASE_URL`, as `j3-bots update` downloads them.
 */
const feedBase = Config.String("J3_RELEASE_FEED_URL").pipe(
  Config.withDefault(REPOSITORY_API),
  Config.map((base) => base.replace(/\/+$/, "")),
);

/** How often the server checks on its own, give or take `JITTER`. */
const CHECK_EVERY = Duration.hours(6);
const JITTER = Duration.minutes(30);
/** The first check after a start that finds no check due later. */
const FIRST_CHECK_AFTER = Duration.minutes(1);
/** A check a client asks for repeats the last one's answer within this. */
const CHECK_AT_MOST_EVERY = Duration.minutes(1);
/** After a check that did not finish, the wait before the next, doubled each time up to `CHECK_EVERY`. */
const FIRST_BACKOFF = Duration.minutes(15);
/** Releases the nightly channel reads, newest first: a week of nightlies and the stable releases between. */
const NIGHTLY_PAGE = 30;
const REQUEST_TIMEOUT = Duration.seconds(30);
/** A whole check, the downloads of a release's two small files included. */
const CHECK_TIMEOUT = Duration.minutes(2);
/** No `SHA256SUMS` or signature is near this; a bigger answer is not one. */
const MAX_LIST_BYTES = 1024 * 1024;

const CandidateRecord = Schema.Struct({
  version: ReleaseVersion,
  channel: UpdateChannelSchema,
  publishedAt: Schema.DateTimeUtc,
  notesUrl: Schema.String,
});

/** What a channel's last answer said, and the ETag to ask with next. */
const ChannelRecord = Schema.Struct({
  etag: Schema.NullOr(Schema.String),
  newest: Schema.NullOr(CandidateRecord),
});
type ChannelRecord = typeof ChannelRecord.Type;

const FeedRecord = Schema.Struct({
  schema: Schema.Literal(1),
  stable: Schema.NullOr(ChannelRecord),
  nightly: Schema.NullOr(ChannelRecord),
  /** Whether each channel's newest release verified when it was last checked: null `failure` when it did. */
  verdicts: Schema.Array(
    Schema.Struct({ version: ReleaseVersion, failure: Schema.NullOr(VerificationFailure) }),
  ),
  lastCheck: Schema.NullOr(
    Schema.Struct({
      at: Schema.DateTimeUtc,
      channel: UpdateChannelSchema,
      failure: Schema.NullOr(ReleaseCheckFailure),
      nextAt: Schema.DateTimeUtc,
    }),
  ),
  /** The wait after the last check that did not finish; 0 after one that did. */
  backoffMinutes: NonNegativeInt,
});
type FeedRecord = typeof FeedRecord.Type;

const FeedRecordJson = Schema.fromJsonString(Schema.toCodecJson(FeedRecord));

const EMPTY: FeedRecord = {
  schema: 1,
  stable: null,
  nightly: null,
  verdicts: [],
  lastCheck: null,
  backoffMinutes: 0,
};

/** What the feed answers: its part of `UpdateStatus`, and whether a check is running. */
export interface FeedStatus extends Pick<
  UpdateStatus,
  "current" | "channel" | "available" | "waitingForStable" | "refused" | "lastCheck"
> {
  readonly checking: boolean;
}

/** Why a check did not finish, and the earliest the releases page allows the next. */
class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  failure: ReleaseCheckFailure,
  retryAt: Schema.NullOr(Schema.DateTimeUtc),
}) {}

const unreachable = () => new CheckFailed({ failure: "unreachable", retryAt: null });
const unreadable = () => new CheckFailed({ failure: "unreadable", retryAt: null });

/** The time a 403 or 429 says to wait until: `retry-after` seconds, or the rate limit's reset when none is left. */
const retryAt = (response: HttpClientResponse.HttpClientResponse, now: DateTime.Utc) => {
  const after = Number(response.headers["retry-after"]);
  if (Number.isFinite(after) && after > 0) return DateTime.add(now, { seconds: after });
  const reset = Number(response.headers["x-ratelimit-reset"]);
  return response.headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)
    ? DateTime.makeUnsafe(reset * 1000)
    : null;
};

export class ReleaseFeed extends Context.Service<
  ReleaseFeed,
  {
    /** What the feed knows now, for the server's channel. */
    readonly status: Effect.Effect<FeedStatus>;
    /** The status now, then each time it changes. */
    readonly changes: Stream.Stream<FeedStatus>;
    /**
     * Checks now, unless the last check of this channel was within
     * `CHECK_AT_MOST_EVERY`, and answers the status once it has ended. A
     * check under way is waited for, not repeated.
     */
    readonly check: Effect.Effect<FeedStatus>;
  }
>()("@j3-bots/server/releases/ReleaseFeed") {}

/** The feed of a server that runs `running`, checking on its own for as long as the scope lasts. */
export const make = Effect.fn("ReleaseFeed.make")(function* (options: {
  readonly running: string;
}) {
  const { running } = options;
  const fs = yield* FileSystem.FileSystem;
  const layout = yield* Layout;
  const settings = yield* SettingsService;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const api = yield* feedBase;
  const downloads = yield* releaseBase;
  const check = signatureCheck(yield* trustedReleaseKeys);
  const file = layout.releaseFeed;

  const loaded = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(FeedRecordJson)),
    Effect.orElseSucceed(() => EMPTY),
  );
  const record = yield* Ref.make(loaded);
  const checking = yield* Ref.make(false);
  const startedAt = yield* DateTime.now;

  const channelNow = Effect.map(settings.get, (saved) => saved.updateChannel);

  const statusOf = (saved: FeedRecord, channel: UpdateChannel, busy: boolean): FeedStatus => {
    const newest = Option.fromNullOr(saved[channel]?.newest ?? null);
    const offered = offer({ newest, running, channel });
    const verdict = Option.flatMap(offered.available, (candidate) =>
      Option.fromUndefinedOr(saved.verdicts.find((each) => each.version === candidate.version)),
    );
    const verified = Option.flatMap(offered.available, (candidate) =>
      Option.isSome(verdict) && verdict.value.failure === null
        ? Option.some({ ...candidate, verified: true })
        : Option.none(),
    );
    return {
      current: { version: running, channel: Option.getOrNull(channelOf(running)) },
      channel,
      available: Option.getOrNull(verified),
      waitingForStable: offered.waitingForStable,
      refused: Option.match(verdict, {
        onNone: () => null,
        onSome: ({ version, failure }) => (failure === null ? null : { version, reason: failure }),
      }),
      lastCheck:
        saved.lastCheck === null
          ? null
          : {
              at: saved.lastCheck.at,
              failure: saved.lastCheck.failure,
              nextAt: saved.lastCheck.nextAt,
            },
      checking: busy,
    };
  };

  const current = Effect.gen(function* () {
    return statusOf(yield* Ref.get(record), yield* channelNow, yield* Ref.get(checking));
  });
  const published = yield* SubscriptionRef.make(yield* current);
  const publish = SubscriptionRef.updateEffect(published, () => current);

  const save = (next: FeedRecord) =>
    Schema.encodeEffect(FeedRecordJson)(next).pipe(
      Effect.flatMap((text) => layout.writeFile(file, text)),
      Effect.catch((error) =>
        Effect.logWarning("Could not keep what the release feed found", { error }),
      ),
    );

  const get = (url: string, headers: Record<string, string>) =>
    client
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachable));

  /** The newest release on `channel`, asked with what `cached` last answered. */
  const fetchNewest = Effect.fn("ReleaseFeed.fetchNewest")(function* (
    channel: UpdateChannel,
    cached: ChannelRecord | null,
  ) {
    const url =
      channel === "stable" ? `${api}/releases/latest` : `${api}/releases?per_page=${NIGHTLY_PAGE}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": `j3-bots/${running}`,
    };
    if (cached?.etag != null) headers["if-none-match"] = cached.etag;
    const response = yield* get(url, headers);
    const now = yield* DateTime.now;
    if (response.status === 304 && cached !== null) return cached;
    // No stable release yet.
    if (response.status === 404 && channel === "stable") return { etag: null, newest: null };
    if (response.status === 403 || response.status === 429) {
      return yield* new CheckFailed({ failure: "rate-limited", retryAt: retryAt(response, now) });
    }
    if (response.status !== 200) return yield* unreadable();
    const json = yield* response.json.pipe(Effect.mapError(unreadable));
    const newest =
      channel === "stable"
        ? yield* Schema.decodeUnknownEffect(GitHubRelease)(json).pipe(
            Effect.map((release) => newestOn([release], "stable")),
            Effect.mapError(unreadable),
          )
        : yield* Schema.decodeUnknownEffect(GitHubReleases)(json).pipe(
            Effect.map((releases) => newestOn(releases, "nightly")),
            Effect.mapError(unreadable),
          );
    return { etag: response.headers["etag"] ?? null, newest: Option.getOrNull(newest) };
  });

  /** A release file's bytes; none when the release has no such file. */
  const download = Effect.fn("ReleaseFeed.download")(function* (version: string, name: string) {
    const response = yield* get(`${downloads}/download/${releaseTag(version)}/${name}`, {
      "user-agent": `j3-bots/${running}`,
    });
    if (response.status === 404) return Option.none<Uint8Array>();
    if (response.status !== 200) return yield* unreachable();
    const length = Number(response.headers["content-length"]);
    if (Number.isFinite(length) && length > MAX_LIST_BYTES) return yield* unreadable();
    const body = yield* response.arrayBuffer.pipe(Effect.mapError(unreachable));
    if (body.byteLength > MAX_LIST_BYTES) return yield* unreadable();
    return Option.some(new Uint8Array(body));
  });

  /** Whether `version`'s `SHA256SUMS` verifies: null when it does, else why not. */
  const verify = Effect.fn("ReleaseFeed.verify")(function* (version: string) {
    const sums = yield* download(version, SUMS_FILE);
    if (Option.isNone(sums)) return "checksums-missing" as const;
    const signature = yield* download(version, SIGNATURE_FILE);
    const verified = verifySums({
      version,
      sums: sums.value,
      signature: Option.getOrNull(signature),
      check,
    });
    return Result.isSuccess(verified) ? null : verified.failure;
  });

  /** The verdicts to keep once `next`'s newest releases are known: only theirs. */
  const verdictsFor = (
    next: Pick<FeedRecord, "stable" | "nightly">,
    verdicts: FeedRecord["verdicts"],
  ) => {
    const newest = new Set(
      [next.stable?.newest?.version, next.nightly?.newest?.version].filter(
        (version) => version !== undefined,
      ),
    );
    return verdicts.filter((verdict) => newest.has(verdict.version));
  };

  const permit = yield* Semaphore.make(1);

  /** Checks `channel`, unless `fresh` says the last check is recent enough. */
  const runCheck = (
    fresh: (saved: FeedRecord, now: DateTime.Utc, channel: UpdateChannel) => boolean,
  ) =>
    permit.withPermits(1)(
      Effect.gen(function* () {
        const channel = yield* channelNow;
        const saved = yield* Ref.get(record);
        if (fresh(saved, yield* DateTime.now, channel)) return;
        yield* Ref.set(checking, true);
        yield* publish;
        const outcome = yield* Effect.gen(function* () {
          const found = yield* fetchNewest(channel, saved[channel]);
          const offered = found.newest !== null && isNewer(found.newest.version, running);
          const verified = saved.verdicts.some(
            (each) => each.version === found.newest?.version && each.failure === null,
          );
          // A release that verified once is not downloaded again; one that
          // was refused is, since a release's files can be fixed in place.
          if (found.newest === null || !offered || verified) {
            return { found, verdicts: saved.verdicts };
          }
          const { version } = found.newest;
          const failure = yield* verify(version);
          return {
            found,
            verdicts: [
              ...saved.verdicts.filter((each) => each.version !== version),
              { version, failure },
            ],
          };
        }).pipe(
          Effect.timeoutOrElse({
            duration: CHECK_TIMEOUT,
            orElse: () => Effect.fail(unreachable()),
          }),
          Effect.result,
        );
        const now = yield* DateTime.now;
        const jitter = Duration.millis(yield* Random.nextIntBetween(0, Duration.toMillis(JITTER)));
        const scheduled: FeedRecord = Result.match(outcome, {
          onSuccess: ({ found, verdicts }) => {
            const channels = { ...saved, [channel]: found };
            return {
              ...channels,
              verdicts: verdictsFor(channels, verdicts),
              // Next due in `CHECK_EVERY`, spread so that servers started
              // together do not ask together.
              lastCheck: {
                at: now,
                channel,
                failure: null,
                nextAt: DateTime.addDuration(now, Duration.sum(CHECK_EVERY, jitter)),
              },
              backoffMinutes: 0,
            };
          },
          onFailure: (failed) => {
            const backoff =
              saved.backoffMinutes === 0
                ? Duration.toMinutes(FIRST_BACKOFF)
                : Math.min(saved.backoffMinutes * 2, Duration.toMinutes(CHECK_EVERY));
            const after = DateTime.add(now, { minutes: backoff });
            // Never later than a regular check would be, whatever a reset says.
            const latest = DateTime.addDuration(now, CHECK_EVERY);
            const nextAt =
              failed.retryAt === null
                ? after
                : DateTime.min(DateTime.max(after, failed.retryAt), latest);
            return {
              ...saved,
              lastCheck: { at: now, channel, failure: failed.failure, nextAt },
              backoffMinutes: backoff,
            };
          },
        });
        yield* Ref.set(record, scheduled);
        yield* save(scheduled);
        if (outcome._tag === "Failure") {
          yield* Effect.logInfo("The release feed could not check", {
            failure: outcome.failure.failure,
          });
        }
      }).pipe(Effect.ensuring(Ref.set(checking, false).pipe(Effect.andThen(publish)))),
    );

  const checkNow = runCheck(
    (saved, now, channel) =>
      saved.lastCheck !== null &&
      saved.lastCheck.channel === channel &&
      saved.lastCheck.failure === null &&
      Duration.isLessThan(DateTime.distance(saved.lastCheck.at, now), CHECK_AT_MOST_EVERY),
  ).pipe(Effect.andThen(current));

  // On its own: when the last check says the next is due, or a minute after
  // a start that has none. It looks again at least each minute, so a check
  // that moved the time, or a clock that jumped, is followed.
  const due = (saved: FeedRecord) =>
    saved.lastCheck?.nextAt ?? DateTime.addDuration(startedAt, FIRST_CHECK_AFTER);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const wait = DateTime.distance(yield* DateTime.now, due(yield* Ref.get(record)));
        if (Duration.isLessThanOrEqualTo(wait, Duration.zero)) {
          yield* runCheck((saved, now) => DateTime.isLessThan(now, due(saved)));
        } else {
          yield* Effect.sleep(Duration.min(wait, Duration.minutes(1)));
        }
      }),
    ),
  );

  // A new channel is checked at once, conditionally, so it costs little.
  yield* Effect.forkScoped(
    settings.changes.pipe(
      Stream.map((saved) => saved.updateChannel),
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(() => publish.pipe(Effect.andThen(runCheck(() => false)))),
    ),
  );

  return ReleaseFeed.of({
    status: SubscriptionRef.get(published),
    changes: SubscriptionRef.changes(published),
    check: checkNow,
  });
});

export const layer = Layer.effect(ReleaseFeed, make({ running: packageJson.version }));
