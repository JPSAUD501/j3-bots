// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type { ServerReadiness } from "../admin/protocol.ts";
import { StepFailed } from "./switch.ts";

/** How long a started release has to answer as itself with its engine ready. Its engine is fetched already. */
export const READY_WITHIN = Duration.minutes(5);

/**
 * What a host sees, at one moment, of the server it started: `exited` when
 * its supervisor says it is gone or failed, with why; otherwise the process
 * its supervisor runs, when it can say, and the server's status reply on the
 * admin channel, when one came.
 */
export type ServerProbe =
  | { readonly _tag: "exited"; readonly reason: string }
  | {
      readonly _tag: "running";
      readonly pid: Option.Option<number>;
      readonly answer: Option.Option<ServerReadiness>;
    };

type Reading =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "ready" }
  | { readonly _tag: "failed"; readonly reason: string };

/**
 * What `probe` says of a server started as `version`: ready once it answers
 * as that version, from the process the supervisor runs, with its engine
 * `ready`. Only the version, the process and the engine's state are read
 * from its reply, so a newer release's reply reads.
 */
const read = (probe: ServerProbe, version: string): Reading => {
  if (probe._tag === "exited") return { _tag: "failed", reason: probe.reason };
  const { answer, pid } = probe;
  if (
    Option.isNone(answer) ||
    answer.value.version !== version ||
    !Option.contains(pid, answer.value.pid)
  ) {
    return { _tag: "waiting" };
  }
  switch (answer.value.engine.state._tag) {
    case "ready":
      return { _tag: "ready" };
    case "incompatible":
      return { _tag: "failed", reason: "its engine is not the version it is pinned to" };
    default:
      return { _tag: "waiting" };
  }
};

/**
 * Waits, polling `probe` each second for `READY_WITHIN` at most, for the
 * server started as `version` to be ready; fails as `step` when it exits,
 * its engine is incompatible, or the time runs out.
 */
export const awaitReady = Effect.fn("transition.awaitReady")(function* <R>(
  version: string,
  probe: Effect.Effect<ServerProbe, never, R>,
  step: "await-new" | "await-old",
) {
  const outcome = yield* Effect.map(probe, (seen) => read(seen, version)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (reading) => reading._tag !== "waiting",
    }),
    Effect.timeoutOption(READY_WITHIN),
  );
  if (Option.isSome(outcome) && outcome.value._tag === "ready") return;
  return yield* new StepFailed({
    step,
    reason:
      Option.isSome(outcome) && outcome.value._tag === "failed"
        ? `J3 Bots ${version} did not start: ${outcome.value.reason}`
        : `J3 Bots ${version} did not answer with its engine ready within ${Duration.format(READY_WITHIN)}`,
  });
});
