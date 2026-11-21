// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { rollBackOver, type Side, StepFailed, type SwitchSteps, switchOver } from "./switch.ts";

type Step = StepFailed["step"];

/**
 * A host as the switch changes it: the release the unit names, whether the
 * unit is enabled (a reboot starts it), the release that runs, the release
 * the command runs, and the databases. A release that starts migrates them,
 * as a newer one would; a failing start does so too before it fails, the
 * worst case. A failing restore leaves them half put back. Each step fails
 * when `failing` names it, or names its nth call as `step@n`. `running` is
 * the side the rollback starts from: with `"new"`, the update succeeded.
 */
const hostWith = (failing: ReadonlyArray<string>, service = true, running: Side = "old") => {
  const host = {
    unit: running,
    enabled: service,
    running: service ? Option.some<Side>(running) : Option.none<Side>(),
    command: running,
    data: (running === "old" ? "as-before" : "migrated") as "as-before" | "migrated" | "half",
    log: [] as Array<Step>,
  };
  const calls = new Map<Step, number>();
  const attempt = (step: Step, change: () => void) =>
    Effect.suspend(() => {
      const call = (calls.get(step) ?? 0) + 1;
      calls.set(step, call);
      host.log.push(step);
      if (failing.includes(step) || failing.includes(`${step}@${call}`)) {
        return Effect.fail(new StepFailed({ step, reason: step }));
      }
      change();
      return Effect.void;
    });
  const start = (side: Side) => {
    const step = side === "new" ? "start-new" : "start-old";
    // `service install` writes the unit, enables it and starts the server before it can fail.
    assert.notStrictEqual(host.data, "half", "no release starts on a half-restored home");
    host.unit = side;
    host.enabled = true;
    host.running = Option.some(side);
    if (side === "new") host.data = "migrated";
    return attempt(step, () => {});
  };
  const steps: SwitchSteps<"snapshot", never> = {
    service,
    stop: attempt("stop", () => {
      host.running = Option.none();
    }),
    disable: attempt("stop", () => {
      host.running = Option.none();
      host.enabled = false;
    }),
    snapshot: attempt("snapshot", () => {}).pipe(Effect.as("snapshot" as const)),
    start: (side) => Effect.suspend(() => start(side)),
    ready: (side) =>
      attempt(side === "new" ? "await-new" : "await-old", () => {
        assert.isTrue(Option.contains(host.running, side), `${side} is ready only while it runs`);
      }),
    restore: () =>
      Effect.suspend(() => {
        assert.isTrue(Option.isNone(host.running), "the files are put back with no server on them");
        assert.isFalse(host.enabled, "a reboot during a restore starts nothing");
        host.data = "half";
        return attempt("restore", () => {
          host.data = "as-before";
        });
      }),
    pointCommand: (side) =>
      attempt("command", () => {
        host.command = side;
      }),
  };
  return { host, steps };
};

/** The old release runs again from the unit and the command, on the databases as they were. */
const assertBackToOld = (host: ReturnType<typeof hostWith>["host"]) => {
  assert.strictEqual(host.unit, "old");
  assert.isTrue(host.enabled);
  assert.isTrue(Option.contains(host.running, "old"));
  assert.strictEqual(host.command, "old");
  assert.strictEqual(host.data, "as-before");
};

describe("an update's switch", () => {
  it.effect("ends with the new release in the unit and the command", () =>
    Effect.gen(function* () {
      const { host, steps } = hostWith([]);
      const outcome = yield* switchOver(steps);
      assert.strictEqual(outcome._tag, "updated");
      assert.deepStrictEqual(host.log, ["stop", "snapshot", "start-new", "await-new", "command"]);
      assert.deepStrictEqual(
        [host.unit, host.running, host.command],
        ["new", Option.some("new"), "new"],
      );
    }),
  );

  const before: ReadonlyArray<{ readonly step: Step; readonly log: ReadonlyArray<Step> }> = [
    { step: "stop", log: ["stop", "start-old", "await-old"] },
    { step: "snapshot", log: ["stop", "snapshot", "start-old", "await-old"] },
  ];
  for (const { step, log } of before) {
    it.effect(`starts the old release again, the databases untouched, when ${step} fails`, () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith([step]);
        const outcome = yield* switchOver(steps);
        assert.strictEqual(outcome._tag, "rolled-back");
        if (outcome._tag !== "rolled-back") return;
        assert.strictEqual(outcome.failed.step, step);
        assert.isTrue(Option.isNone(outcome.restored));
        assert.deepStrictEqual(host.log, log);
        assertBackToOld(host);
      }),
    );
  }

  for (const step of ["start-new", "await-new"] as const) {
    it.effect(`puts the databases back under the old release when ${step} fails`, () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith([step]);
        const outcome = yield* switchOver(steps);
        assert.strictEqual(outcome._tag, "rolled-back");
        if (outcome._tag !== "rolled-back") return;
        assert.strictEqual(outcome.failed.step, step);
        assert.isTrue(Option.contains(outcome.restored, "snapshot"));
        assert.deepStrictEqual(host.log.slice(-4), ["stop", "restore", "start-old", "await-old"]);
        assertBackToOld(host);
      }),
    );
  }

  it.effect("keeps the new release once it was ready, when only the command fails", () =>
    Effect.gen(function* () {
      const { host, steps } = hostWith(["command"]);
      const outcome = yield* switchOver(steps);
      // A turn may have run on the new databases: putting the old ones back would lose it.
      assert.strictEqual(outcome._tag, "updated");
      if (outcome._tag !== "updated") return;
      assert.strictEqual(Option.getOrThrow(outcome.command).step, "command");
      assert.deepStrictEqual([host.unit, host.running], ["new", Option.some("new")]);
      assert.strictEqual(host.data, "migrated");
      assert.notInclude(host.log, "restore");
    }),
  );

  it.effect("never starts the old release on databases it could not put back", () =>
    Effect.gen(function* () {
      const { host, steps } = hostWith(["await-new", "restore"]);
      const outcome = yield* switchOver(steps);
      assert.strictEqual(outcome._tag, "rollback-failed");
      if (outcome._tag !== "rollback-failed") return;
      assert.deepStrictEqual(
        [outcome.failed.step, outcome.rollback.step],
        ["await-new", "restore"],
      );
      assert.isTrue(Option.contains(outcome.snapshot, "snapshot"));
      assert.deepStrictEqual(host.log.slice(-2), ["stop", "restore"]);
      assert.strictEqual(host.command, "old");
      // Half put back, and nothing starts the service until a restore finishes.
      assert.strictEqual(host.data, "half");
      assert.isFalse(host.enabled);
      assert.isTrue(Option.isNone(host.running));
    }),
  );

  for (const failing of [
    ["await-new", "stop@2"],
    ["await-new", "start-old"],
    ["stop", "await-old"],
  ]) {
    it.effect(`reports both failures when ${failing.join(" and then ")} fail`, () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith(failing);
        const outcome = yield* switchOver(steps);
        assert.strictEqual(outcome._tag, "rollback-failed");
        if (outcome._tag !== "rollback-failed") return;
        assert.strictEqual(outcome.failed.step, failing[0]?.replace(/@\d+$/, ""));
        assert.strictEqual(outcome.rollback.step, failing[1]?.replace(/@\d+$/, ""));
        // The command is pointed at the new release only once it is ready.
        assert.strictEqual(host.command, "old");
      }),
    );
  }

  describe("without a service", () => {
    it.effect("copies the databases, then points the command at the new release", () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith([], false);
        assert.strictEqual((yield* switchOver(steps))._tag, "updated");
        assert.deepStrictEqual(host.log, ["snapshot", "command"]);
        assert.strictEqual(host.command, "new");
      }),
    );

    for (const step of ["snapshot", "command"] as const) {
      it.effect(`leaves the old release in place when ${step} fails`, () =>
        Effect.gen(function* () {
          const { host, steps } = hostWith([step], false);
          const outcome = yield* switchOver(steps);
          assert.strictEqual(outcome._tag, "rolled-back");
          assert.strictEqual(host.command, "old");
          assert.strictEqual(host.data, "as-before");
          assert.isTrue(Option.isNone(host.running));
        }),
      );
    }
  });

  describe("a rollback the operator asks for", () => {
    it.effect("puts the databases back, then starts the old release and points the command", () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith([], true, "new");
        const failed = yield* rollBackOver(steps, "snapshot");
        assert.isTrue(Option.isNone(failed));
        assert.deepStrictEqual(host.log, ["stop", "restore", "start-old", "await-old", "command"]);
        assertBackToOld(host);
      }),
    );

    it.effect("leaves the service disabled and stopped when the restore fails", () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith(["restore"], true, "new");
        const failed = yield* rollBackOver(steps, "snapshot");
        assert.strictEqual(Option.getOrThrow(failed).step, "restore");
        assert.deepStrictEqual(host.log, ["stop", "restore"]);
        assert.isFalse(host.enabled);
        assert.isTrue(Option.isNone(host.running));
        assert.strictEqual(host.command, "new");
      }),
    );

    it.effect("finishes a restore a cut-off rollback left, when run again", () =>
      Effect.gen(function* () {
        const { host, steps } = hostWith(["restore@1"], true, "new");
        yield* rollBackOver(steps, "snapshot");
        const failed = yield* rollBackOver(steps, "snapshot");
        assert.isTrue(Option.isNone(failed));
        assertBackToOld(host);
      }),
    );
  });
});
