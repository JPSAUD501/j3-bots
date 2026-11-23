// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, DeviceId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import * as Ids from "../Ids.ts";
import { configFor } from "../testing/database.ts";
import { TransitionLock } from "../transition/transition.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import type { UpdateHost } from "./host.ts";
import { LaunchFailed, type UpdateUnitPlan } from "./launch.ts";
import { advanceRun, endRun } from "./run.ts";
import { UpdateLauncher } from "./UpdateLauncher.ts";
import * as UpdateRuns from "./UpdateRuns.ts";

const NEXT = "99.0.0";
const DEVICE = DeviceId.make("device_test");

const COMMAND = "/install/versions/current/bin/j3-bots";

const SERVICE: UpdateHost = {
  _tag: "service",
  command: COMMAND,
  home: "/unused",
  searchPath: "/usr/bin",
};

/** A machine as the runs see it: how the server is run, its units, and the bots' work. */
interface Machine {
  host: UpdateHost;
  /** Whether each run's unit has ended. */
  ended: boolean;
  /** Whether `systemd-run` fails. */
  launchFails: boolean;
  working: ReadonlyArray<BotId>;
  readonly launched: Array<UpdateUnitPlan>;
}

const machineOf = (more: Partial<Machine> = {}): Machine => ({
  host: SERVICE,
  ended: false,
  launchFails: false,
  working: [],
  launched: [],
  ...more,
});

/** `use` with the runs of a server on `home`: each call is a server start, as after a restart. */
const withRuns = <A, E, R>(
  home: string,
  machine: Machine,
  use: (runs: UpdateRuns.UpdateRuns["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.flatMap(
      Effect.gen(function* () {
        return yield* UpdateRuns.UpdateRuns;
      }),
      use,
    ).pipe(
      Effect.provide(
        UpdateRuns.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, configFor(path, home)),
              Layer.succeed(
                UpdateLauncher,
                UpdateLauncher.of({
                  host: Effect.sync(() => machine.host),
                  launch: (plan) =>
                    machine.launchFails
                      ? Effect.fail(new LaunchFailed({ output: "Failed to connect to bus" }))
                      : Effect.sync(() => {
                          machine.launched.push(plan);
                        }),
                  ended: () => Effect.sync(() => machine.ended),
                }),
              ),
              Layer.succeed(RunningWork, RunningWork.of({ bots: Effect.sync(() => machine.working) })),
              Ids.layer,
            ),
          ),
        ),
      ),
    );
  });

const tempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "j3-update-runs-" });
});

const ask = (more: Partial<UpdateRuns.StartRequest> = {}): UpdateRuns.StartRequest => ({
  version: NEXT,
  stopWork: false,
  device: DEVICE,
  available: Option.some(NEXT),
  ...more,
});

/** Why `start` refused, or none when it started. */
const refusal = (exit: Exit.Exit<void, { readonly reason: string; readonly runningBots: number | null }>) =>
  Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), ({ reason, runningBots }) => ({ reason, runningBots }))
    : Option.none();

it.layer(NodeServices.layer)("updates a client asks for", (it) => {
  it.effect("tells every client how the update ended, from the server that runs after it", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const machine = machineOf();
      const during = yield* withRuns(home, machine, (runs) =>
        Effect.gen(function* () {
          yield* runs.start(ask());
          return yield* runs.view;
        }),
      );
      const [plan] = machine.launched;
      assert.deepInclude(plan, { version: NEXT, command: COMMAND });
      assert.strictEqual(during.state._tag, "downloading");
      assert.deepInclude(during.run, { from: packageJson.version, to: NEXT, by: DEVICE });
      assert.isNull(during.lastResult);

      // What `j3-bots update --run` writes, in its unit, while the service restarts.
      const id = plan?.id ?? "";
      yield* advanceRun(home, id, { _tag: "restarting" });
      yield* endRun(home, id, {
        _tag: "rolled-back",
        reason: "health-check",
        detail: "J3 Bots 99.0.0 did not answer ready within 5 minutes.",
      });
      machine.ended = true;

      const after = yield* withRuns(home, machine, (runs) => runs.view);
      assert.strictEqual(after.state._tag, "idle");
      assert.isNull(after.run);
      assert.deepInclude(after.lastResult, {
        outcome: "rolled-back",
        from: packageJson.version,
        to: NEXT,
        by: DEVICE,
        reason: "health-check",
        detail: "J3 Bots 99.0.0 did not answer ready within 5 minutes.",
      });
    }),
  );

  it.effect("ends as interrupted a run whose unit ended without saying how", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const machine = machineOf();
      yield* withRuns(home, machine, (runs) => runs.start(ask()));
      machine.ended = true;
      const view = yield* withRuns(home, machine, (runs) => runs.view);
      assert.strictEqual(view.state._tag, "idle");
      assert.deepInclude(view.lastResult, { outcome: "failed", reason: "interrupted" });
      assert.include(view.lastResult?.detail ?? "", `journalctl --user -u j3-bots-update-`);
    }),
  );

  it.effect("records an update whose unit did not start, which changed nothing", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const view = yield* withRuns(home, machineOf({ launchFails: true }), (runs) =>
        Effect.andThen(runs.start(ask()), runs.view),
      );
      assert.strictEqual(view.state._tag, "idle");
      assert.deepInclude(view.lastResult, { outcome: "rolled-back", reason: "other" });
      assert.include(view.lastResult?.detail ?? "", "Failed to connect to bus");
    }),
  );

  describe("starts only the feed's verified release, one at a time", () => {
    it.effect("refuses a version the feed does not offer, and starts nothing", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const machine = machineOf();
        const other = yield* withRuns(home, machine, (runs) =>
          runs.start(ask({ version: "98.0.0" })).pipe(Effect.exit),
        );
        const none = yield* withRuns(home, machine, (runs) =>
          runs.start(ask({ available: Option.none() })).pipe(Effect.exit),
        );
        assert.deepStrictEqual(refusal(other), Option.some({ reason: "not-available", runningBots: null }));
        assert.deepStrictEqual(refusal(none), Option.some({ reason: "not-available", runningBots: null }));
        assert.deepStrictEqual(machine.launched, []);
      }),
    );

    it.effect("refuses on a server that cannot update itself", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const machine = machineOf({
          host: { _tag: "cannot", reason: "started-by-hand", command: "j3-bots update" },
        });
        const view = yield* withRuns(home, machine, (runs) => runs.view);
        assert.deepStrictEqual(view.canUpdate, {
          _tag: "unable",
          reason: "started-by-hand",
          command: "j3-bots update",
        });
        const exit = yield* withRuns(home, machine, (runs) => runs.start(ask()).pipe(Effect.exit));
        assert.deepStrictEqual(refusal(exit), Option.some({ reason: "unable", runningBots: null }));
        assert.deepStrictEqual(machine.launched, []);
      }),
    );

    it.effect("refuses while an update runs, from a client or from a shell", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const machine = machineOf();
        yield* withRuns(home, machine, (runs) => runs.start(ask()));
        const again = yield* withRuns(home, machine, (runs) => runs.start(ask()).pipe(Effect.exit));
        assert.deepStrictEqual(refusal(again), Option.some({ reason: "busy", runningBots: null }));

        const other = yield* tempHome;
        const shell = yield* Effect.scoped(
          Effect.andThen(
            TransitionLock.hold(other, () => "held"),
            withRuns(other, machine, (runs) => runs.start(ask()).pipe(Effect.exit)),
          ),
        );
        assert.deepStrictEqual(refusal(shell), Option.some({ reason: "busy", runningBots: null }));
        assert.strictEqual(machine.launched.length, 1);
      }),
    );

    it.effect("asks before it stops the bots' work, and starts once told to", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const machine = machineOf({ working: [BotId.make("bot_a"), BotId.make("bot_b")] });
        const asked = yield* withRuns(home, machine, (runs) => runs.start(ask()).pipe(Effect.exit));
        assert.deepStrictEqual(refusal(asked), Option.some({ reason: "work-running", runningBots: 2 }));
        assert.deepStrictEqual(machine.launched, []);
        yield* withRuns(home, machine, (runs) => runs.start(ask({ stopWork: true })));
        assert.strictEqual(machine.launched.length, 1);
      }),
    );
  });
});
