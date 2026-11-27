// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { storedToken } from "./Credential.ts";
import { engineFolders } from "./PrivateFiles.ts";
import { CONNECTION_FILE, StoredConnection } from "./Provision.ts";

// What of the engine a diagnostics zip may hold (docs/decisions/0100-…): the
// values the engine keeps that the zip's scrubber must take out, and the
// engine's log, read from the trace file T3 Code writes, of which only what
// says something went wrong leaves, in J3 Bots' own shape.

/**
 * T3 Code's trace file and the files it moves aside, newest first:
 * `userdata/logs/server.trace.ndjson`, then `.1` to `.10`, one JSON span per
 * line (**Read** at `bc0f04d`, `config.ts` `serverTracePath` and
 * `traceMaxFiles`, `shared/logging.ts` for the rotation). The local file is
 * written whatever the engine's export settings, so turning its telemetry
 * off leaves it (**Read**, `Observability.ts`, `makeLocalFileTracer`).
 */
const TRACE_FILE = "server.trace.ndjson";
const TRACE_FILES = 11;

/** A trace file larger than this is passed over: T3 Code moves one aside at 10 MiB. */
const MAX_TRACE_FILE_BYTES = 32 * 1024 * 1024;

/** The most a value in the engine's secret store may take: each is one variable. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** The longest log message or error name a line keeps. */
const MAX_TEXT = 300;

const TraceEvent = Schema.Struct({
  name: Schema.String,
  timeUnixNano: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});

const TraceExit = Schema.Union([
  Schema.TaggedStruct("Success", {}),
  Schema.TaggedStruct("Interrupted", { cause: Schema.String }),
  Schema.TaggedStruct("Failure", { cause: Schema.String }),
]);

/** A span as the trace file holds it, as far as the log reads it (`shared/observability.ts`). */
const TraceSpan = Schema.Struct({
  type: Schema.Literals(["effect-span", "otlp-span"]),
  name: Schema.String,
  endTimeUnixNano: Schema.String.check(Schema.isPattern(/^\d{1,30}$/)),
  durationMs: Schema.Number,
  exit: Schema.optionalKey(TraceExit),
  status: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
  events: Schema.Array(TraceEvent),
});
type TraceSpan = typeof TraceSpan.Type;

const decodeSpan = Schema.decodeUnknownOption(Schema.fromJsonString(TraceSpan));

/** How a span ended, in J3 Bots' words. */
type EngineSpanOutcome = "success" | "failure" | "interrupted";

/** One line of the engine's log as a diagnostics zip holds it. */
const EngineLogLine = Schema.Struct({
  /** When the span ended, or when its log was written. */
  at: Schema.String,
  /** The engine's name for the work, as its code names it. */
  span: Schema.String,
  ms: Schema.Number,
  outcome: Schema.Literals(["success", "failure", "interrupted"]),
  /** The name of the error a failed span ended with, never its message. */
  error: Schema.optionalKey(Schema.String),
  /** The warnings and errors the work logged, each its level and its message. */
  logs: Schema.Array(Schema.Struct({ level: Schema.String, message: Schema.String })),
});
type EngineLogLine = typeof EngineLogLine.Type;

const encodeLine = Schema.encodeSync(Schema.fromJsonString(EngineLogLine));

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** What takes the operator's secrets and names out of a text, before it is cut. */
type Clean = (text: string) => string;

/**
 * The name of the error a cause begins with, as Effect prints a cause: the
 * first line's leading identifier before a `:`. A cause that does not begin
 * so, a message alone, is `unknown`: its text is never kept.
 */
const errorName = (cause: string, clean: Clean): string => {
  const match = /^\s*([A-Za-z_$][\w$]*)(?::|\s*$)/m.exec(cause.split("\n", 1)[0] ?? "");
  return match?.[1] === undefined ? "unknown" : cut(clean(match[1]));
};

const LOUD_LEVELS = new Set(["warning", "warn", "error", "fatal"]);

const isoOfNanos = (nanos: string): Option.Option<string> =>
  Option.map(DateTime.make(Number(BigInt(nanos) / 1_000_000n)), DateTime.formatIso);

/**
 * `span` as a line of the zip's engine log, or none when nothing in it went
 * wrong: a span that succeeded and logged no warning or error says nothing a
 * diagnosis needs, and most spans are those.
 */
const lineOf = (span: TraceSpan, clean: Clean): Option.Option<EngineLogLine> => {
  const outcome: EngineSpanOutcome =
    span.exit?._tag === "Failure" || span.status?.code === "ERROR"
      ? "failure"
      : span.exit?._tag === "Interrupted"
        ? "interrupted"
        : "success";
  const logs = span.events.flatMap((event) => {
    const level = event.attributes["effect.logLevel"];
    return Predicate.isString(level) && LOUD_LEVELS.has(level.toLowerCase())
      ? [{ level, message: cut(clean(event.name)) }]
      : [];
  });
  if (outcome === "success" && logs.length === 0) return Option.none();
  return Option.map(isoOfNanos(span.endTimeUnixNano), (at) => ({
    at,
    span: cut(clean(span.name)),
    ms: Math.round(span.durationMs * 10) / 10,
    outcome,
    ...(span.exit?._tag === "Failure" ? { error: errorName(span.exit.cause, clean) } : {}),
    logs,
  }));
};

/**
 * The engine's log for an engine data directory at `home`, newest first, as
 * JSON lines of `EngineLogLine`, from `since` on. Each file is read only
 * once the lines before it were taken, and the reading stops at the first
 * file last written before `since`. A line that does not decode as a span of
 * T3 Code's trace file is left out rather than trusted. Each text a line
 * keeps goes through `clean` whole, before it is cut, so a secret is never
 * cut in two where `clean` cannot find it.
 */
export const engineLogNewestFirst = (
  home: string,
  since: DateTime.Utc,
  clean: Clean,
): Stream.Stream<string, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(engineFolders(path, home).userdata, "logs");
      const sinceIso = DateTime.formatIso(since);
      const files = Array.from({ length: TRACE_FILES }, (_, index) =>
        path.join(folder, index === 0 ? TRACE_FILE : `${TRACE_FILE}.${index}`),
      );
      /** The file's lines, newest first, or none once the file is too old, too large or missing. */
      const linesOf = Effect.fn("linesOf")(
        function* (file: string) {
          const info = yield* fs.stat(file);
          const written = Option.getOrUndefined(info.mtime);
          if (written !== undefined && written.getTime() < since.epochMilliseconds) {
            return { lines: [], older: true };
          }
          if (Number(info.size) > MAX_TRACE_FILE_BYTES) return { lines: [], older: false };
          const text = yield* fs.readFileString(file);
          const lines = text
            .split("\n")
            .toReversed()
            .flatMap((raw) =>
              Option.toArray(
                Option.flatMap(decodeSpan(raw), (span) => lineOf(span, clean)).pipe(
                  Option.filter((line) => line.at >= sinceIso),
                  Option.map(encodeLine),
                ),
              ),
            );
          return { lines, older: false };
        },
        Effect.orElseSucceed(() => ({ lines: [], older: false })),
      );
      return Stream.fromIterable(files).pipe(
        Stream.mapEffect(linesOf),
        Stream.takeUntil((read) => read.older),
        Stream.flatMap((read) => Stream.fromIterable(read.lines)),
      );
    }),
  );

const decodeConnection = Schema.decodeOption(Schema.fromJsonString(StoredConnection));

/** The secret values of the secret store's file `name`, holding `text`. */
const valuesOf = (name: string, text: string): ReadonlyArray<string> =>
  name === CONNECTION_FILE
    ? [text, ...Option.toArray(Option.map(decodeConnection(text), (connection) => connection.key))]
    : [text];

/**
 * The secret values the engine's data directory at `home` holds, for a
 * diagnostics zip to take out wherever they appear: J3 Bots' token for the
 * engine, and each value in the engine's secret store, whole. The provider
 * connection's file also gives its key alone, since a log could name the key
 * without the URL beside it; its URL is no secret. A store or a value that is
 * there but cannot be read fails: the zip is not made without it.
 */
export const engineSecretValues = Effect.fn("engine.secretValues")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = engineFolders(path, home);
  const names = yield* fs
    .readDirectory(folders.secrets)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const values = yield* Effect.forEach(names, (name) => {
    const file = path.join(folders.secrets, name);
    return fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && Number(info.size) <= MAX_SECRET_FILE_BYTES
          ? Effect.map(fs.readFileString(file), (text) => valuesOf(name, text.trim()))
          : Effect.succeed([]),
      ),
      // Removed since the folder was read: nothing to take out.
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    );
  });
  return [
    ...Option.toArray(yield* storedToken(home)),
    ...values
      .flat()
      .filter((value) => value.length > 0)
      .map((value) => Redacted.make(value)),
  ];
});
