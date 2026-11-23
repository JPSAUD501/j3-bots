// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { SHELL_OVERRIDES } from "../config.ts";

// How the server starts an update a client asked for. The update stops the
// service, so it cannot run in the server's process or as its child: the
// unit's cgroup ends with the service. It runs as a transient unit of the same
// user manager, outside that cgroup, as the same user with the service's
// environment, and with no privilege the user does not already have. What it
// runs is the installed release's own `j3-bots update`, the command the
// operator runs in a shell, so a client-asked update and one from a shell are
// the same transition (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md).

/** The prefix of every update's transient unit: `j3-bots-update-<run>`. */
const UNIT_PREFIX = "j3-bots-";

/** The transient unit of run `id`. */
export const updateUnit = (id: string) => `${UNIT_PREFIX}${id.replace("_", "-")}.service`;

/** What the transient unit runs, and with what. */
export interface UpdateUnitPlan {
  /** The run, `update_…`. */
  readonly id: string;
  /** The version to install, exactly. */
  readonly version: string;
  /** The `j3-bots` of the release that runs now, absolute. */
  readonly command: string;
  /** The service's `J3_HOME`, also the working directory. */
  readonly home: string;
  /** The service's `PATH`. */
  readonly searchPath: string;
  /**
   * Where the service takes releases from and which key it trusts beside the
   * project's (`RELEASE_VARIABLES`), as its environment sets them: the update
   * downloads and verifies what the server offered, from the same place.
   */
  readonly release: Readonly<Record<string, string>>;
}

/** The variables that say where releases come from and which key signs them (`docs/operations/install.md`). */
export const RELEASE_VARIABLES = ["J3_RELEASE_BASE_URL", "J3_RELEASE_PUBLIC_KEY"] as const;

/**
 * `systemd-run`'s arguments for `plan`. The unit is collected once it ends,
 * failed or not, so a second run never finds its name taken; what it printed
 * stays in the journal (`journalctl --user -u j3-bots-update-…`).
 *
 * The environment is the service's: its home, `PATH` and release variables, and none of the
 * variables a shell may set to override the configuration file, which the
 * user manager could otherwise pass on (as the service's unit unsets them).
 * `NoNewPrivileges` keeps anything it runs from gaining a privilege through a
 * set-user-id program: an update needs none.
 *
 * systemd expands `$NAME` and `${NAME}` in a transient unit's command, as in
 * a unit file's `ExecStart=` (and not `%` specifiers), so each word has its
 * `$` doubled. The environment it sets is taken as it is.
 */
export const systemdRunArgs = (plan: UpdateUnitPlan): ReadonlyArray<string> => [
  "--user",
  `--unit=${updateUnit(plan.id)}`,
  "--collect",
  "--quiet",
  // `systemd-run` answers once the command started, or failed to.
  "--property=Type=exec",
  "--property=NoNewPrivileges=yes",
  `--property=UnsetEnvironment=${SHELL_OVERRIDES.join(" ")}`,
  `--setenv=J3_HOME=${plan.home}`,
  `--setenv=PATH=${plan.searchPath}`,
  ...Object.entries(plan.release).map(([name, value]) => `--setenv=${name}=${value}`),
  `--working-directory=${plan.home}`,
  `--description=J3 Bots update to ${plan.version}`,
  "--",
  ...[plan.command, "update", "--version", plan.version, "--yes", "--run", plan.id].map((word) =>
    word.replaceAll("$", () => "$$"),
  ),
];

/** `systemd-run` did not start the update. */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  output: Schema.String,
}) {
  override get message(): string {
    const output = this.output.trim();
    return `systemd-run could not start the update${output === "" ? "." : `: ${output}`}`;
  }
}

/** Starts the update `plan` names in its transient unit, and returns once it runs. */
export const launch = Effect.fn("update.launch")(function* (plan: UpdateUnitPlan) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("systemd-run", [...systemdRunArgs(plan)], { stdin: "ignore" }),
      );
      const [output, exitCode] = yield* Effect.all(
        [handle.all.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
        { concurrency: 2 },
      );
      return { output, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.mapError((cause) => new LaunchFailed({ output: cause.message })));
  if (result.exitCode !== 0) return yield* new LaunchFailed({ output: result.output });
});
