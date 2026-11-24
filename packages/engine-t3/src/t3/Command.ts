// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Duration from "effect/Duration";
import * as ChildProcess from "effect/process/ChildProcess";

/** How long a short command (unpacking the engine, minting a credential, `ps`) gets to stop. */
const SHORT_COMMAND_STOP = "2 seconds";

/**
 * A command the adapter runs. When its scope closes while it still runs, as
 * on the server's stop, it gets SIGTERM and then, once `stopWithin` has
 * passed, SIGKILL: a child that ignores SIGTERM never holds the stop up. The
 * spawner's own default would wait for it without limit.
 */
export const boundedCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  options: Omit<ChildProcess.CommandOptions, keyof ChildProcess.KillOptions> = {},
  stopWithin: Duration.Input = SHORT_COMMAND_STOP,
) =>
  ChildProcess.make(executable, args, {
    ...options,
    killSignal: "SIGTERM",
    forceKillAfter: stopWithin,
  });

/**
 * The variables the engine is started with, from the server's own: what a
 * process needs to run as the operator's user (the search path, the home and
 * user, the shell, the locale and time zone, the temporary folder, the user's
 * runtime folder and session bus), and how it reaches the network (proxies and
 * extra certificate authorities). Nothing else passes: a variable that
 * configures T3 Code or a harness (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `OPENAI_API_KEY`, `T3CODE_HOME`) would give bots the
 * operator's own credentials, folders or service.
 *
 * Windows names the same needs differently, and a program there cannot start
 * without some of them: `SystemRoot` (Windows' own folder, which its network
 * and crypto libraries load from), `ComSpec` and `PATHEXT` (how a `.cmd`
 * harness is started), the profile and its application data folders, the
 * temporary folders, the program folders, and the machine's and user's names.
 * Node starts no Windows program without some of them anyway: libuv copies
 * the server's `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`,
 * `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR`
 * into any environment it is given that lacks them (`required_vars` in
 * `src/win/process.c`). So they are all on the list, which is then exactly
 * what the engine gets; `LOGONSERVER` names the server that signed the user
 * in, and is set only where one did.
 */
const PASSED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Windows' names, compared without case as Windows compares them. */
const PASSED_ON_WINDOWS = new Set(
  [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "LOGONSERVER",
    "COMPUTERNAME",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase()),
);

const passes = (name: string, platform: string) =>
  platform === "win32"
    ? PASSED_ON_WINDOWS.has(name.toUpperCase())
    : PASSED.has(name) || name.startsWith("LC_");

/**
 * The environment the engine starts with on `platform`: the allowed part of
 * the server's. The engine passes its environment on to every harness it
 * starts, so a bot's harness is configured only by what J3 Bots provisions.
 */
export const engineEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  platform: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parent).flatMap(([name, value]) =>
      value === undefined || !passes(name, platform) ? [] : [[name, value]],
    ),
  );
