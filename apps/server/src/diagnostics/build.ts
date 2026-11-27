// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The machine's name, its user and its system's release have no Effect API.
import * as NodeOs from "node:os";
import { type DiagnosticsClient, EngineStatus, PROTOCOL_VERSION } from "@j3-bots/contracts";
import { engineLogNewestFirst, engineSecretValues, pinnedRelease } from "@j3-bots/engine-t3/live";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { ServerConfigShape } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { logFiles } from "../logs/ServerLogFile.ts";
import { everyValue } from "../secrets/transfer.ts";
import { readRun } from "../update/run.ts";
import { makeScrubber } from "./scrub.ts";
import { type ZipEntry, zipStream } from "./zip.ts";

// A diagnostics zip (docs/decisions/0100-…): what the server knows of how it
// runs, for the operator to send to whoever helps them, and nothing of the
// person. Every file is text, and every text goes through one scrubber
// before it is written (`scrub.ts`). The logs are the newest lines that fit
// their budget; the other files are small by what they hold.

/** How far back the logs go. */
const LOG_DAYS = 7;

/**
 * The most each log may take in the zip, as text: the newest lines that fit.
 * With every other file well under 256 KiB, the zip is never more than 24 MiB.
 */
interface LogBudgets {
  readonly server: number;
  readonly engine: number;
}

const LOG_BUDGETS: LogBudgets = { server: 14 * 1024 * 1024, engine: 6 * 1024 * 1024 };

/** The most failures the zip lists, newest first. */
const MAX_FAILURES = 500;

/** The longest error a line of the server's log keeps: enough for a stack. */
const MAX_CAUSE = 8 * 1024;

/** How the server is installed and run, as far as the zip says it. */
export type InstallKind = "service" | "desktop" | "checkout" | "release";

export interface DiagnosticsSources {
  /** When the zip is made. Every file in it carries this time. */
  readonly at: DateTime.Utc;
  /** The client the zip was asked from; none for `j3-bots diagnostics`. */
  readonly client: Option.Option<DiagnosticsClient>;
  /** The J3 Bots release the server runs. */
  readonly version: string;
  /** When the server started; none when it is not running. */
  readonly startedAt: Option.Option<DateTime.Utc>;
  readonly install: InstallKind;
  /** The engine and its providers as the server sees them; none when it is not running. */
  readonly engine: Option.Option<EngineStatus>;
  /** Secret values the running server holds only in memory, to take out as well. */
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
  readonly budgets?: LogBudgets;
}

/** The names of the zip's files, in the order it holds them. */
export const DIAGNOSTICS_FILES = [
  "README.md",
  "server-log.jsonl",
  "engine-log.jsonl",
  "engine.json",
  "failures.json",
  "updates.json",
  "migrations.json",
  "counts.json",
  "settings.json",
  "telemetry.json",
  "manifest.json",
] as const;
type DiagnosticsFile = (typeof DIAGNOSTICS_FILES)[number];

const LOGS: ReadonlySet<DiagnosticsFile> = new Set(["server-log.jsonl", "engine-log.jsonl"]);

const README = `# J3 Bots diagnostics

This zip says how a J3 Bots server runs, for whoever helps its operator: a
person or an AI. It holds no messages, no names of bots, rooms or people,
and no secrets. Every file went through the same scrubber before it was
written: a secret value the server keeps reads \`[secret]\`, anything shaped
like a token \`[token]\`, the operator's home folder \`~\`, and their user
name, the machine's name, IP addresses and email addresses \`[user]\`,
\`[host]\`, \`[ipv4]\`, \`[ipv6]\` and \`[email]\`. Bots, rooms and the
rest appear by their ids alone (\`bot_…\`, \`room_…\`).

- \`manifest.json\`: what made the zip and when: J3 Bots' release, the engine
  it is pinned to, the protocol, the client the zip was asked from, the
  system, how the server is installed, how long it has run, its time zone,
  and how many lines of each log the zip holds and whether older ones were
  left out.
- \`server-log.jsonl\`: the server's log for the last ${LOG_DAYS} days, oldest
  first, one JSON line each: \`timestamp\`, \`level\`, \`message\`,
  \`annotations\`, \`spans\` and, for an error, \`cause\`. When the days hold
  more than ${LOG_BUDGETS.server / 1024 / 1024} MiB, only the newest lines that fit.
- \`engine-log.jsonl\`: the engine's work that went wrong over the same days,
  oldest first: each piece of work that failed, was interrupted or logged a
  warning or an error, with its name (\`span\`), how long it took (\`ms\`),
  the name of the error it ended with, and its warnings. At most
  ${LOG_BUDGETS.engine / 1024 / 1024} MiB, the newest kept.
- \`engine.json\`: the engine's state and each provider's: ready, signed in or
  not, why one cannot run, its harness's version and J3 Bots' copy of it.
- \`failures.json\`: the failures the server told the operator of in the last
  ${LOG_DAYS} days, newest first: what failed, in which conversation or room,
  and when.
- \`updates.json\`: the last update of J3 Bots and the engine release recorded.
- \`migrations.json\`: the database changes applied, in order.
- \`counts.json\`: how many bots, rooms, routines, connectors, conversations
  and paired devices there are. Numbers only.
- \`settings.json\`: the server's settings. A setting that could hold a secret
  or a path reads \`set\` or \`not set\`.
- \`telemetry.json\`: what the server sends to J3 Bots' developers on its own.

A file the server could not read holds \`{ "unreadable": … }\` and says why.
`;

/** A file of the zip that could not be made, saying why instead. */
const unreadable = (why: string) => json({ unreadable: why });

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

const encodeEngineStatus = Schema.encodeSync(Schema.toCodecJson(EngineStatus));

/** A line of the server's log, as `Logger.formatJson` writes it: anything else is left out. */
const ServerLogLine = Schema.Struct({
  timestamp: Schema.String,
  level: Schema.String,
  message: Schema.Unknown,
  cause: Schema.optionalKey(Schema.String),
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Number),
});
const decodeServerLine = Schema.decodeUnknownOption(Schema.fromJsonString(ServerLogLine));
const encodeServerLine = Schema.encodeSync(Schema.fromJsonString(ServerLogLine));

/**
 * The server's log in `folder` from `since` on, newest first, each line
 * re-encoded with only the fields the log writes. A file is read only once
 * the lines after it were taken, and the reading stops at the first one last
 * written before `since`.
 */
const serverLogNewestFirst = (
  folder: string,
  since: DateTime.Utc,
): Stream.Stream<string, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sinceIso = DateTime.formatIso(since);
      const linesOf = Effect.fn("diagnostics.serverLogFile")(
        function* (file: string) {
          const info = yield* fs.stat(file);
          if (Option.exists(info.mtime, (written) => written.getTime() < since.epochMilliseconds)) {
            return { lines: [], older: true };
          }
          const text = yield* fs.readFileString(file);
          const lines = text
            .split("\n")
            .toReversed()
            .flatMap((raw) =>
              Option.toArray(
                decodeServerLine(raw).pipe(
                  Option.filter((line) => line.timestamp >= sinceIso),
                  Option.map((line) =>
                    encodeServerLine(
                      line.cause !== undefined && line.cause.length > MAX_CAUSE
                        ? { ...line, cause: `${line.cause.slice(0, MAX_CAUSE)}…` }
                        : line,
                    ),
                  ),
                ),
              ),
            );
          return { lines, older: false };
        },
        Effect.orElseSucceed(() => ({ lines: [], older: false })),
      );
      return Stream.fromIterable(logFiles(path, folder)).pipe(
        Stream.mapEffect(linesOf),
        Stream.takeUntil((read) => read.older),
        Stream.flatMap((read) => Stream.fromIterable(read.lines)),
      );
    }),
  );

/** What the zip holds of a log. */
interface KeptLog {
  readonly lines: number;
  /** Whether older lines of the days were left out to keep within the budget. */
  readonly cut: boolean;
}

/**
 * The newest lines of `newestFirst`, scrubbed, that fit in `budget` bytes,
 * as a file oldest first. The lines past the budget are never read.
 */
const keepNewest = <R>(
  newestFirst: Stream.Stream<string, never, R>,
  budget: number,
  scrub: (text: string) => string,
) =>
  newestFirst.pipe(
    Stream.map(scrub),
    Stream.mapAccum(
      () => 0,
      (total, line) => {
        const next = total + byteLength(line) + 1;
        return [next, [{ line, fits: next <= budget }]] as const;
      },
    ),
    Stream.takeUntil((each) => !each.fits),
    Stream.runCollect,
    Effect.map((taken) => {
      const kept = taken.filter((each) => each.fits).map((each) => each.line);
      const log: KeptLog = { lines: kept.length, cut: kept.length < taken.length };
      return { text: kept.length === 0 ? "" : `${kept.toReversed().join("\n")}\n`, log };
    }),
  );

const Count = Schema.Number;
const Counts = Schema.Struct({
  bots: Count,
  hidden_bots: Count,
  active_rooms: Count,
  archived_rooms: Count,
  routines: Count,
  enabled_routines: Count,
  catalog_connectors: Count,
  custom_connectors: Count,
  conversations: Count,
  sections: Count,
  devices: Count,
});

const Flag = Schema.Number;
const Settings = Schema.Struct({
  time_zone: Schema.String,
  time_zone_set: Flag,
  hop_limit: Count,
  fan_out_limit: Count,
  concurrent_turns: Count,
  notifications_enabled: Flag,
  notification_previews: Flag,
  update_channel: Schema.String,
  auto_update_harnesses: Flag,
  suggest_replies: Flag,
  operator_name_set: Flag,
});

const Failure = Schema.Struct({
  created_at: Schema.String,
  conversation_bot_id: Schema.NullOr(Schema.String),
  room_id: Schema.NullOr(Schema.String),
  notice: Schema.String,
  failure: Schema.NullOr(Schema.String),
});

const Migration = Schema.Struct({
  migration_id: Schema.Number,
  name: Schema.String,
  created_at: Schema.String,
});

const Release = Schema.Struct({ version: Schema.String, recorded_at: Schema.String });

const SecretValue = Schema.Struct({ value: Schema.String });

/** The notices that say something failed: the rest say what happened. */
const FAILURE_NOTICES = [
  "chain-stopped",
  "turn-failed",
  "handoff-failed",
  "undelivered",
  "session-lost",
  "session-not-ready",
  "permission-mode-refused",
  "member-mode-refused",
  "settings-held",
  "observation-failed",
  "too-long",
  "routine-paused",
] as const;

const setOrNot = (value: Option.Option<unknown>) => (Option.isSome(value) ? "set" : "not set");

const flag = (value: number) => value === 1;

/**
 * The secret values the database keeps in the clear, for the scrubber: each
 * routine's webhook secret, each event subscription's token and signing
 * secret, and each phone's push token.
 */
const databaseSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: SecretValue,
    execute: () => sql`
      SELECT webhook_secret AS value FROM routines WHERE webhook_secret IS NOT NULL
      UNION ALL SELECT webhook_token FROM routine_event_listeners WHERE webhook_token IS NOT NULL
      UNION ALL SELECT webhook_secret FROM routine_event_listeners WHERE webhook_secret IS NOT NULL
      UNION ALL SELECT token FROM push_registrations
    `,
  })(undefined).pipe(
    Effect.map((rows) => rows.map((row) => Redacted.make(row.value))),
    // Without them no file could be trusted to hold none: no zip is made.
    Effect.orDie,
  );
});

/**
 * The operator's home folder and login name, for the scrubber. A user the
 * system has no entry for leaves only the home folder known.
 */
const machine = Effect.try({
  try: () => {
    const user = NodeOs.userInfo();
    return { home: user.homedir, user: user.username };
  },
  catch: () => "no-user-entry" as const,
}).pipe(Effect.orElseSucceed(() => ({ home: NodeOs.homedir(), user: "" })));

const operatingSystem = (platform: string) =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;

/**
 * The diagnostics zip of the server `config` describes, as its bytes are
 * made, from what is on disk and what `sources` says of the running server.
 * Reads the database through `SqlClient` and never writes to it. Each file is
 * made only when the one before it was zipped, so at most one log is held in
 * memory at a time. A file that cannot be made says so instead: the zip is
 * always made.
 */
export const diagnosticsZip = Effect.fn("diagnostics.zip")(function* (
  config: ServerConfigShape,
  sources: DiagnosticsSources,
) {
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
  const budgets = sources.budgets ?? LOG_BUDGETS;
  const since = DateTime.subtract(sources.at, { days: LOG_DAYS });
  const sinceIso = DateTime.formatIso(since);

  const secrets = [
    ...sources.secrets,
    ...(yield* everyValue(path.join(config.home, HOME_ENTRIES.secrets))),
    ...(yield* engineSecretValues(config.engineHome)),
    ...(yield* databaseSecrets),
  ];
  const scrub = makeScrubber({ secrets, ...(yield* machine), host: NodeOs.hostname() });

  const logs: Partial<Record<"server" | "engine", KeptLog>> = {};

  const query = <Row extends Schema.Constraint, E>(
    result: Row,
    execute: () => Effect.Effect<ReadonlyArray<unknown>, E>,
  ) =>
    SqlSchema.findAll({ Request: Schema.Void, Result: result, execute })(undefined).pipe(
      Effect.provide(context),
    );

  const sections: Record<
    DiagnosticsFile,
    Effect.Effect<string, SqlError.SqlError | Schema.SchemaError, FileSystem.FileSystem | Path.Path>
  > = {
    "README.md": Effect.succeed(README),
    "server-log.jsonl": keepNewest(
      serverLogNewestFirst(path.join(config.home, HOME_ENTRIES.logs), since),
      budgets.server,
      scrub,
    ).pipe(
      Effect.map(({ text, log }) => {
        logs.server = log;
        return text;
      }),
    ),
    "engine-log.jsonl": keepNewest(
      engineLogNewestFirst(config.engineHome, since),
      budgets.engine,
      scrub,
    ).pipe(
      Effect.map(({ text, log }) => {
        logs.engine = log;
        return text;
      }),
    ),
    "engine.json": Effect.succeed(
      Option.match(sources.engine, {
        onNone: () => unreadable("The server is not running, so the engine's state is not known."),
        onSome: (status) => json(encodeEngineStatus(status)),
      }),
    ),
    "failures.json": query(
      Failure,
      () => sql`
        SELECT created_at, conversation_bot_id, room_id,
          json_extract(body_json, '$.notice._tag') AS notice,
          json_extract(body_json, '$.notice.failure') AS failure
        FROM entries
        WHERE kind = 'notice' AND created_at >= ${sinceIso}
          AND json_extract(body_json, '$.notice._tag') IN ${sql.in(FAILURE_NOTICES)}
        ORDER BY seq DESC
        LIMIT ${MAX_FAILURES}
      `,
    ).pipe(
      Effect.map((rows) =>
        json(
          rows.map((row) => ({
            at: row.created_at,
            notice: row.notice,
            ...(row.failure === null ? {} : { failure: row.failure }),
            ...(row.conversation_bot_id === null ? {} : { conversation: row.conversation_bot_id }),
            ...(row.room_id === null ? {} : { room: row.room_id }),
          })),
        ),
      ),
    ),
    "updates.json": Effect.gen(function* () {
      const recorded = yield* readRun(config.home);
      const [release] = yield* query(
        Release,
        () => sql`SELECT version, recorded_at FROM engine_release WHERE id = 1`,
      );
      const lastUpdate =
        recorded._tag === "recorded"
          ? {
              from: recorded.run.from,
              to: recorded.run.to,
              startedAt: DateTime.formatIso(recorded.run.startedAt),
              stage: recorded.run.stage._tag,
              ...(recorded.run.outcome === undefined
                ? {}
                : {
                    outcome: recorded.run.outcome._tag,
                    at: DateTime.formatIso(recorded.run.outcome.at),
                    ...(recorded.run.outcome._tag === "done"
                      ? {}
                      : {
                          reason: recorded.run.outcome.reason,
                          detail: recorded.run.outcome.detail,
                        }),
                  }),
            }
          : recorded._tag;
      return json({
        lastUpdate,
        engineRelease:
          release === undefined
            ? "none"
            : { version: release.version, recordedAt: release.recorded_at },
      });
    }),
    "migrations.json": query(
      Migration,
      () =>
        sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`,
    ).pipe(
      Effect.map((rows) =>
        json(rows.map((row) => ({ id: row.migration_id, name: row.name, at: row.created_at }))),
      ),
    ),
    "counts.json": query(
      Counts,
      () => sql`
        SELECT
          (SELECT COUNT(*) FROM bots) AS bots,
          (SELECT COUNT(*) FROM bots WHERE hidden = 1) AS hidden_bots,
          (SELECT COUNT(*) FROM rooms WHERE status = 'active') AS active_rooms,
          (SELECT COUNT(*) FROM rooms WHERE status = 'archived') AS archived_rooms,
          (SELECT COUNT(*) FROM routines) AS routines,
          (SELECT COUNT(*) FROM routines WHERE enabled = 1) AS enabled_routines,
          (SELECT COUNT(*) FROM connectors WHERE listing_json IS NOT NULL) AS catalog_connectors,
          (SELECT COUNT(*) FROM connectors WHERE listing_json IS NULL) AS custom_connectors,
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM sections) AS sections,
          (SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL) AS devices
      `,
    ).pipe(
      Effect.map(([counts]) =>
        counts === undefined
          ? unreadable("The database holds no counts.")
          : json({
              bots: counts.bots,
              hiddenBots: counts.hidden_bots,
              rooms: { active: counts.active_rooms, archived: counts.archived_rooms },
              routines: { all: counts.routines, enabled: counts.enabled_routines },
              connectors: { catalog: counts.catalog_connectors, custom: counts.custom_connectors },
              conversations: counts.conversations,
              sections: counts.sections,
              pairedDevices: counts.devices,
            }),
      ),
    ),
    "settings.json": query(
      Settings,
      () => sql`
        SELECT time_zone, time_zone_set, hop_limit, fan_out_limit, concurrent_turns,
          notifications_enabled, notification_previews, update_channel,
          auto_update_harnesses, suggest_replies, operator_name IS NOT NULL AS operator_name_set
        FROM settings WHERE id = 1
      `,
    ).pipe(
      Effect.map(([settings]) =>
        json({
          server: {
            host: config.host,
            privateOnly: config.privateOnly,
            port: config.port,
            enginePort: config.enginePort,
            toolPort: config.toolPort,
            tls: setOrNot(config.tls),
            publicOrigin: setOrNot(config.publicOrigin),
            engineBinary: setOrNot(config.engineBinary),
            scriptedAgent: setOrNot(config.scriptedAgent),
            webClient: config.webClient._tag,
          },
          ...(settings === undefined
            ? {}
            : {
                operator: {
                  timeZone: settings.time_zone,
                  timeZoneSet: flag(settings.time_zone_set),
                  operatorName: flag(settings.operator_name_set) ? "set" : "not set",
                  hopLimit: settings.hop_limit,
                  fanOutLimit: settings.fan_out_limit,
                  concurrentTurns: settings.concurrent_turns,
                  notifications: flag(settings.notifications_enabled),
                  notificationPreviews: flag(settings.notification_previews),
                  updateChannel: settings.update_channel,
                  autoUpdateHarnesses: flag(settings.auto_update_harnesses),
                  suggestReplies: flag(settings.suggest_replies),
                },
              }),
        }),
      ),
    ),
    "telemetry.json": Effect.succeed(json(telemetry())),
    "manifest.json": query(
      Schema.Struct({ time_zone: Schema.String }),
      () => sql`SELECT time_zone FROM settings WHERE id = 1`,
    ).pipe(
      Effect.map(([settings]) => settings?.time_zone ?? null),
      Effect.orElseSucceed(() => null),
      Effect.map((timeZone) =>
        json({
          madeAt: DateTime.formatIso(sources.at),
          j3Bots: sources.version,
          engine: {
            pinned: Option.match(sources.engine, {
              onNone: () => pinnedRelease,
              onSome: (status) => status.pinnedVersion,
            }),
            ...Option.match(sources.engine, {
              onNone: () => ({}),
              onSome: (status) =>
                status.state._tag === "incompatible"
                  ? { running: status.state.runningVersion }
                  : {},
            }),
          },
          protocol: PROTOCOL_VERSION,
          requestedFrom: Option.match(sources.client, {
            onNone: () => ({ surface: "j3-bots diagnostics" }),
            onSome: (client) => client,
          }),
          system: {
            os: operatingSystem(process.platform),
            release: NodeOs.release(),
            arch: process.arch,
            node: process.versions.node,
          },
          install: sources.install,
          running: Option.isSome(sources.startedAt),
          ...Option.match(sources.startedAt, {
            onNone: () => ({}),
            onSome: (startedAt) => ({
              startedAt: DateTime.formatIso(startedAt),
              uptimeSeconds: Math.round(
                (sources.at.epochMilliseconds - startedAt.epochMilliseconds) / 1000,
              ),
            }),
          }),
          timeZone,
          logs: { since: sinceIso, ...logs },
        }),
      ),
    ),
  };

  const entries = Stream.fromIterable(DIAGNOSTICS_FILES).pipe(
    Stream.mapEffect((name) =>
      sections[name].pipe(
        Effect.orElseSucceed(() => unreadable("The server could not read it.")),
        // A log is scrubbed as each line is taken, so its budget counts what the zip holds.
        Effect.map((text): ZipEntry => ({ name, text: LOGS.has(name) ? text : scrub(text) })),
        Effect.provide(context),
      ),
    ),
  );
  return zipStream(entries, sources.at);
});

/**
 * What the server sends to J3 Bots' developers on its own: nothing, in this
 * release. Where the zip would say whether telemetry is on and list what was
 * last sent, once the server has a telemetry switch.
 */
const telemetry = () => ({ sends: "nothing" });
