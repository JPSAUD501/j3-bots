// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** A `systemctl --user` command that did not succeed. */
export class SystemdFailed extends Schema.TaggedError<SystemdFailed>()("SystemdFailed", {
  command: Schema.String,
  output: Schema.String,
}) {
  override get message(): string {
    const output = this.output.trim();
    return `\`${this.command}\` failed${output === "" ? "." : `: ${output}`}`;
  }
}

/**
 * Whether the user's services keep running with no one logged in, and start
 * at boot: `loginctl`'s `Linger`.
 */
export type Linger = "yes" | "no" | "unknown";

/** What `systemctl --user` says of one unit. */
export interface UnitState {
  /** Starts with the user manager, at boot when lingering is on. */
  readonly enabled: boolean;
  /** `active`, `inactive`, `failed`, `activating`, …, as systemd names it. */
  readonly active: string;
}

/** The user's systemd manager: no `sudo`, ever. */
export class Systemd extends Context.Service<
  Systemd,
  {
    /** The user manager answers: there is a `systemctl --user` to talk to. */
    readonly available: Effect.Effect<boolean>;
    readonly linger: Effect.Effect<Linger>;
    readonly unitState: (unit: string) => Effect.Effect<UnitState>;
    /**
     * Whether the kernel lets the user manager limit memory: the memory cgroup
     * controller is delegated to it. Without it, `MemoryHigh` does nothing.
     */
    readonly memoryControllerDelegated: Effect.Effect<boolean>;
    readonly reload: Effect.Effect<void, SystemdFailed>;
    /** Enables the unit and starts it, or restarts it if it runs. */
    readonly enableAndRestart: (unit: string) => Effect.Effect<void, SystemdFailed>;
    readonly disableAndStop: (unit: string) => Effect.Effect<void, SystemdFailed>;
  }
>()("@j3-bots/server/system/Systemd") {}

export const layer = Layer.effect(
  Systemd,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;

    /** Runs a command to its end: its exit code and its output, or none if it could not start. */
    const run = (command: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, [...args], { stdin: "ignore" }),
          );
          const [output, exitCode] = yield* Effect.all(
            [handle.all.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
            { concurrency: 2 },
          );
          return { exitCode: Number(exitCode), output };
        }),
      ).pipe(Effect.option);

    const systemctl = (args: ReadonlyArray<string>) => run("systemctl", ["--user", ...args]);
    const must = (args: ReadonlyArray<string>) =>
      systemctl(args).pipe(
        Effect.flatMap((result) =>
          result._tag === "Some" && result.value.exitCode === 0
            ? Effect.void
            : Effect.fail(
                new SystemdFailed({
                  command: `systemctl --user ${args.join(" ")}`,
                  output: result._tag === "Some" ? result.value.output : "systemctl was not found",
                }),
              ),
        ),
      );

    const uid = process.getuid?.() ?? -1;

    return Systemd.of({
      available: systemctl(["show-environment"]).pipe(
        Effect.map((result) => result._tag === "Some" && result.value.exitCode === 0),
      ),
      linger: run("loginctl", ["show-user", String(uid), "--property=Linger", "--value"]).pipe(
        Effect.map((result) => {
          if (result._tag === "None" || result.value.exitCode !== 0) return "unknown";
          const value = result.value.output.trim();
          return value === "yes" ? "yes" : value === "no" ? "no" : "unknown";
        }),
      ),
      unitState: Effect.fn("Systemd.unitState")((unit: string) =>
        Effect.all({
          enabled: systemctl(["is-enabled", unit]).pipe(
            Effect.map((result) => result._tag === "Some" && result.value.exitCode === 0),
          ),
          active: systemctl(["is-active", unit]).pipe(
            Effect.map((result) =>
              result._tag === "Some" ? result.value.output.trim() || "unknown" : "unknown",
            ),
          ),
        }),
      ),
      memoryControllerDelegated: fs
        .readFileString(
          `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
        )
        .pipe(
          Effect.map((controllers) => controllers.split(/\s+/).includes("memory")),
          Effect.orElseSucceed(() => false),
        ),
      reload: must(["daemon-reload"]),
      enableAndRestart: Effect.fn("Systemd.enableAndRestart")(function* (unit: string) {
        yield* must(["enable", unit]);
        yield* must(["restart", unit]);
      }),
      disableAndStop: Effect.fn("Systemd.disableAndStop")(function* (unit: string) {
        yield* must(["disable", "--now", unit]);
      }),
    });
  }),
);
