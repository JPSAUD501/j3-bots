// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off -- The watch waits on a timer it unrefs, which only Node's own timers allow (`Effect.sleep` holds the process), so that the watch itself never keeps the process running.
import * as NodeTimers from "node:timers";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// What keeps a stopping server's process running, said when it runs for too
// long: whether the server released everything it held, and what Node still
// waits on. Node waits on each active handle not unreferenced (a socket, a
// timer, a child process); its diagnostic report lists them.

/** An address a socket is bound or connected to, as Node's diagnostic report gives it. */
const Endpoint = Schema.Struct({
  ip4: Schema.optionalKey(Schema.String),
  ip6: Schema.optionalKey(Schema.String),
  port: Schema.Number,
});

/** One libuv handle of the report: what it is, and what says which one. */
const Handle = Schema.Struct({
  type: Schema.String,
  is_active: Schema.Boolean,
  is_referenced: Schema.optionalKey(Schema.Boolean),
  localEndpoint: Schema.optionalKey(Schema.NullOr(Endpoint)),
  remoteEndpoint: Schema.optionalKey(Schema.NullOr(Endpoint)),
  pid: Schema.optionalKey(Schema.Number),
  fd: Schema.optionalKey(Schema.Number),
  firesInMsFromNow: Schema.optionalKey(Schema.Number),
});
type Handle = typeof Handle.Type;

const Report = Schema.Struct({ libuv: Schema.Array(Handle) });
const decodeReport = Schema.decodeUnknownOption(Report);

const address = (endpoint: typeof Endpoint.Type) =>
  `${endpoint.ip4 ?? (endpoint.ip6 === undefined ? "?" : `[${endpoint.ip6}]`)}:${endpoint.port}`;

/**
 * `handle` in a few words: its kind, and where it goes or listens, its
 * process, when it fires, or else its descriptor.
 */
const describeHandle = (handle: Handle): string => {
  const which =
    handle.remoteEndpoint != null
      ? `to ${address(handle.remoteEndpoint)}`
      : handle.localEndpoint != null
        ? `on ${address(handle.localEndpoint)}`
        : handle.pid !== undefined
          ? `pid ${handle.pid}`
          : handle.firesInMsFromNow !== undefined
            ? `in ${handle.firesInMsFromNow} ms`
            : handle.fd !== undefined && handle.fd >= 0
              ? `fd ${handle.fd}`
              : null;
  return which === null ? handle.type : `${handle.type} ${which}`;
};

/**
 * The handles that keep this process running, from a diagnostic report:
 * each active one not unreferenced, but the event loop's own entry. None
 * when the report does not read as one.
 */
export const holdersIn = (report: unknown): Option.Option<ReadonlyArray<string>> =>
  Option.map(decodeReport(report), ({ libuv }) =>
    libuv
      .filter(
        (handle) => handle.type !== "loop" && handle.is_active && handle.is_referenced !== false,
      )
      .map(describeHandle),
  );

/** What a stop that ran for too long found still there. */
export interface Lingering {
  /** Whether the server had released everything it held. */
  readonly released: boolean;
  /** What keeps the process running, as `holdersIn` says it, when the report reads. */
  readonly holding: ReadonlyArray<string> | null;
}

/** A stop under watch: `begun` once it starts, `released` once the server let go of everything. */
export interface StopWatch {
  /** Starts the watch, once: a later call changes nothing. */
  readonly begun: Effect.Effect<void>;
  readonly released: Effect.Effect<void>;
}

/**
 * Watches a stop: if the process still runs `after` from when it began,
 * `report` is told what it found. The wait never keeps the process running,
 * so a process that ends in time reports nothing.
 */
export const watchStop = (
  after: Duration.Duration,
  report: (lingering: Lingering) => Effect.Effect<void>,
): Effect.Effect<StopWatch> =>
  Effect.sync(() => {
    let begun = false;
    let released = false;
    return {
      begun: Effect.sync(() => {
        if (begun) return;
        begun = true;
        NodeTimers.setTimeout(() => {
          Effect.runFork(
            report({
              released,
              holding: Option.getOrNull(holdersIn(process.report.getReport())),
            }),
          );
        }, Duration.toMillis(after)).unref();
      }),
      released: Effect.sync(() => {
        released = true;
      }),
    };
  });
