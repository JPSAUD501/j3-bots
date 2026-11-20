// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { SHELL_OVERRIDES } from "../config.ts";

/** The systemd user unit J3 Bots installs: `~/.config/systemd/user/j3-bots.service`. */
export const UNIT_NAME = "j3-bots.service";

/** Where the user's systemd manager reads the unit from. */
export const unitPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"));
  const base = Option.isSome(configHome)
    ? configHome.value
    : path.join(yield* Config.NonEmptyString("HOME"), ".config");
  return path.join(base, "systemd", "user", UNIT_NAME);
});

/**
 * The `J3_HOME` of the unit installed at `unitFile`: the home its server
 * runs with, whatever this shell's is. `None` for a unit that names none.
 */
export const installedHome = Effect.fn("service.installedHome")(function* (unitFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const unit = yield* fs.readFileString(unitFile);
  return Option.fromNullishOr(environmentOf(unit).get("J3_HOME"));
});

/**
 * The `PATH` the service gets, made from the installing shell's: each folder
 * by its real path, without the ones under `runtimeDirectory`
 * (`XDG_RUNTIME_DIR`). A version manager such as fnm puts a per-shell link to
 * the active Node there, which is gone after a reboot; its real path, where
 * `npm --global` installs harnesses, stays.
 */
export const servicePath = Effect.fn("service.servicePath")(function* (
  searchPath: string,
  runtimeDirectory: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transient = (folder: string) =>
    Option.isSome(runtimeDirectory) &&
    (folder === runtimeDirectory.value || folder.startsWith(`${runtimeDirectory.value}/`));
  const folders: Array<string> = [];
  for (const entry of searchPath.split(":")) {
    if (entry === "" || !path.isAbsolute(entry)) continue;
    const folder = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry));
    if (!transient(folder) && !folders.includes(folder)) folders.push(folder);
  }
  return folders.join(":");
});

/**
 * The `Environment=` assignments of a unit this module rendered, as systemd
 * reads them: quotes grouped, escapes and `%%` undone.
 */
export const environmentOf = (unit: string): ReadonlyMap<string, string> => {
  const environment = new Map<string, string>();
  for (const line of unit.split("\n")) {
    if (!line.startsWith("Environment=")) continue;
    for (const word of unquote(line.slice("Environment=".length))) {
      const separator = word.indexOf("=");
      if (separator > 0) environment.set(word.slice(0, separator), word.slice(separator + 1));
    }
  }
  return environment;
};

/** The words of one setting's value, the inverse of `quote`. */
const unquote = (value: string) => {
  const words: Array<string> = [];
  let word = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quoted) {
      word += value[++index] ?? "";
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === " " && !quoted) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words.map((each) => each.replaceAll("%%", "%"));
};

/**
 * The environment the service runs with, as a configuration source: the
 * user's `HOME`, the unit's `J3_HOME` and `PATH`, and nothing else, so none of
 * a shell's overrides.
 */
export const asTheService = (environment: {
  readonly home: string;
  readonly j3Home: string;
  readonly searchPath: string;
}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({
      HOME: environment.home,
      J3_HOME: environment.j3Home,
      PATH: environment.searchPath,
    }),
  );

/** What the unit runs, and with what. */
export interface UnitPlan {
  /** The Node executable, absolute: a unit has no shell to find it on `PATH`. */
  readonly node: string;
  /** The CLI's entry point, absolute. */
  readonly entryPoint: string;
  /** `J3_HOME`, also the working directory. */
  readonly home: string;
  /** The `PATH` the server and the harnesses it starts get, such as where `claude` and `codex` are. */
  readonly searchPath: string;
  readonly totalMemoryBytes: number;
}

/** A value systemd cannot take in a unit, such as a path with a newline. */
class UnitValueRefused extends Schema.TaggedError<UnitValueRefused>()("UnitValueRefused", {
  setting: Schema.String,
  value: Schema.String,
}) {
  override get message(): string {
    return `${this.setting} (${JSON.stringify(this.value)}) cannot be written into a systemd unit. Choose a path without control characters, quotes or backslashes.`;
  }
}

/**
 * The share of the machine's memory past which systemd makes the service give
 * memory back before it takes more: the server, the engine and every harness
 * it runs share it. On a 4 GB Raspberry Pi that leaves about 1.6 GB to the
 * system and everything else. It slows the service down under pressure and
 * never kills it.
 */
const MEMORY_HIGH_SHARE = 0.6;

const MIB = 1024 * 1024;

/** systemd expands `%` specifiers in these settings. */
const escapeSpecifiers = (value: string) => value.replaceAll("%", "%%");

/** `ExecStart=` also expands `$NAME` and `${NAME}` from the environment. */
const escapeVariables = (value: string) => value.replaceAll("$", "$$");

/** One word of a command line or an environment assignment, quoted when it needs to be. */
const quote = (value: string) => {
  const escaped = escapeSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
};

const CONTROL = /[\u0000-\u001f\u007f]/;
// systemd refuses an executable path with a quote or a backslash, even quoted.
const UNSAFE_EXECUTABLE = /[\u0000-\u001f\u007f"'\\]/;

/** The unit's text. */
export const render = Effect.fn("service.render")(function* (plan: UnitPlan) {
  if (UNSAFE_EXECUTABLE.test(plan.node)) {
    return yield* new UnitValueRefused({ setting: "Node executable", value: plan.node });
  }
  for (const [setting, value] of [
    ["Entry point", plan.entryPoint],
    ["J3_HOME", plan.home],
    ["PATH", plan.searchPath],
  ] as const) {
    if (CONTROL.test(value)) return yield* new UnitValueRefused({ setting, value });
  }
  const memoryHigh = Math.floor((plan.totalMemoryBytes * MEMORY_HIGH_SHARE) / MIB);
  return [
    "[Unit]",
    "Description=J3 Bots server",
    // Five failed starts within five minutes stop the restarts; `doctor` says so.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    // The rest of a line, unquoted: only specifiers are expanded.
    `WorkingDirectory=${escapeSpecifiers(plan.home)}`,
    `Environment=${quote(`J3_HOME=${plan.home}`)}`,
    `Environment=${quote(`PATH=${plan.searchPath}`)}`,
    // The user manager passes on its own environment (`systemctl --user
    // set-environment`, a desktop session's import). An override there would
    // replace the settings `service install` checked.
    `UnsetEnvironment=${SHELL_OVERRIDES.join(" ")}`,
    `ExecStart=${[plan.node, plan.entryPoint, "serve"].map((word) => quote(escapeVariables(word))).join(" ")}`,
    // The server stops the engine and its harnesses itself; systemd ends what
    // is left once the stop times out. A stop takes at most the HTTP grace
    // (5 s), the WebSocket close (2 s) and the engine's (10 s), well inside it.
    "KillMode=mixed",
    "TimeoutStopSec=30",
    // SIGTERM interrupts the server, which then exits 130: that is a clean stop.
    "SuccessExitStatus=130",
    "Restart=on-failure",
    "RestartSec=5",
    `MemoryHigh=${memoryHigh}M`,
    // A harness the kernel kills for memory ends its own turn, not the service.
    "OOMPolicy=continue",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
});
