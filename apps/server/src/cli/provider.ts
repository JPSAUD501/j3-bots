// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AdminClient } from "../admin/AdminClient.ts";
import { baseUrlForm, CONNECT_RESTARTS, providerBaseUrlProblem } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { type Harness, HARNESSES } from "../engine/harnesses.ts";
import { homeLayout, PROVIDER_HOMES } from "../home/entries.ts";
import * as Home from "../home/Home.ts";
import { Host } from "../system/Host.ts";
import { refuse, userFacing } from "./errors.ts";

const NOT_RUNNING =
  "The server is not running, and it is the running server that hands the connection to the engine. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run this again.";

/** What a refused connection leaves in force. */
const refused = (active: string | null) =>
  [
    "The engine's data refused the connection, so it was not stored. The server's log names the folder: `journalctl --user -u j3-bots`.",
    active === null
      ? "No provider connection is in force."
      : `The connection in force is still the one to ${active}.`,
  ].join("\n");

/**
 * The base URL as the engine is given it, from what the operator typed: the
 * endpoint's root, without a trailing `/` or `/v1`, which each harness adds
 * itself. Otherwise why it cannot be one (`providerBaseUrlProblem`).
 */
export const normalizeBaseUrl = (
  text: string,
):
  | { readonly _tag: "url"; readonly url: string }
  | { readonly _tag: "problem"; readonly problem: string } => {
  const trimmed = text.trim();
  // Written in its base form, unless that would drop a part the check refuses.
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  const plain =
    url !== null && url.username === "" && url.password === "" && !/[?#]/.test(trimmed)
      ? baseUrlForm(url)
      : trimmed;
  const bare = plain.replace(/\/+$/, "");
  const root = bare.endsWith("/v1") ? bare.slice(0, -"/v1".length) : bare;
  const problem = providerBaseUrlProblem(root);
  return problem === undefined ? { _tag: "url", url: root } : { _tag: "problem", problem };
};

/**
 * The key: typed without echo on a terminal, or read whole from standard
 * input, so a script can pipe it without it reaching the command line, the
 * shell's history or the process list.
 */
const readKey = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    const typed = yield* Prompt.run(Prompt.Hidden({ message: "The endpoint's key" }));
    return Redacted.value(typed).trim();
  }
  const piped = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  return piped.trim();
});

const EXAMPLES =
  "For example: https://proxy.example.com, or http://127.0.0.1:8317 for an endpoint on this machine.";

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription(
    "The endpoint's base URL: https, such as https://proxy.example.com, or http to this machine, such as http://127.0.0.1:8317. It must speak Anthropic's Messages API and OpenAI's Responses API. Asked for when left out.",
  ),
  Flag.optional,
);

/**
 * The endpoint's base URL: the flag's, or asked for on a terminal, so the
 * bare command runs as typed. Without a terminal it can only come from the
 * flag.
 */
const readBaseUrl = Effect.fn("readBaseUrl")(function* (flag: Option.Option<string>) {
  if (Option.isSome(flag)) {
    const root = normalizeBaseUrl(flag.value);
    if (root._tag === "url") return root.url;
    // The text is not repeated: it may hold a credential.
    return yield* refuse(
      `--base-url is not a base URL J3 Bots can use: ${root.problem}. ${EXAMPLES}`,
    );
  }
  if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
    return yield* refuse(
      "Give the endpoint's base URL with --base-url when the key comes from standard input.",
    );
  }
  // The prompt submits what `validate` returns: the normalized base URL.
  return yield* Prompt.run(
    Prompt.String({
      message: "The endpoint's base URL",
      validate: (text) => {
        const root = normalizeBaseUrl(text);
        return root._tag === "url"
          ? Effect.succeed(root.url)
          : Effect.fail(`Not a base URL J3 Bots can use: ${root.problem}. ${EXAMPLES}`);
      },
    }),
  ).pipe(Effect.mapError(() => refuse("No base URL was read, so nothing changed.")));
});

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Restart the engine without asking, also when bots have work running, which the restart stops.",
  ),
);

const bots = (count: number) => (count === 1 ? "1 bot has" : `${count} bots have`);

/** Without a terminal to ask on, a restart that stops work needs `--yes`. */
const workRunning = (count: number) =>
  `${bots(count)} work running, and restarting the engine for the new connection stops it. Nothing changed. Run this again with --yes to restart anyway, or once the work is done.`;

const connect = Command.make("connect", { baseUrl: baseUrlFlag, yes: yesFlag }).pipe(
  Command.withDescription(
    `Connect Claude Code and Codex to an endpoint that serves their models, such as a proxy in front of your subscriptions. Asks for its base URL unless given, then for its key, or reads the key from standard input. The key is kept only in the engine's secret store. ${CONNECT_RESTARTS}`,
  ),
  Command.withHandler(({ baseUrl, yes }) =>
    Effect.gen(function* () {
      const url = yield* readBaseUrl(baseUrl);
      const socket = yield* userFacing(ServerConfig.resolveAdminSocket);
      const admin = yield* AdminClient;
      if (Option.isNone(yield* userFacing(admin.status(socket)))) return yield* refuse(NOT_RUNNING);
      const key = yield* readKey.pipe(
        Effect.mapError(() => refuse("No key was read, so nothing changed.")),
      );
      if (key.length === 0) return yield* refuse("The key is empty, so nothing changed.");
      const send = (stopWork: boolean) =>
        userFacing(admin.connectProviders(socket, { baseUrl: url, key, stopWork })).pipe(
          Effect.flatMap((answer) =>
            Option.isNone(answer) ? refuse(NOT_RUNNING) : Effect.succeed(answer.value),
          ),
        );
      let outcome = yield* send(yes);
      if (outcome._tag === "work-running") {
        // The key came from standard input: there is no terminal to ask on.
        if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
          return yield* refuse(workRunning(outcome.bots));
        }
        const restart = yield* Prompt.run(
          Prompt.Confirm({
            message: `${bots(outcome.bots)} work running. Restarting the engine for the new connection stops it. Restart now?`,
            initial: false,
          }),
        ).pipe(Effect.orElseSucceed(() => false));
        if (!restart) return yield* Console.log("Nothing changed.");
        outcome = yield* send(true);
      }
      switch (outcome._tag) {
        case "work-running":
          return yield* refuse(workRunning(outcome.bots));
        case "refused":
          return yield* refuse(refused(outcome.active));
        case "stored":
          return yield* Console.log(
            [
              `The connection to ${outcome.baseUrl} is stored, and the engine is not back yet: it starts with this connection.`,
              "`j3-bots doctor` shows when it is ready; the server's log says what holds it up: `journalctl --user -u j3-bots`.",
            ].join("\n"),
          );
        case "applied":
          return yield* Console.log(
            [
              `The engine restarted with the stored connection: Claude Code and Codex reach their models through ${outcome.baseUrl}.`,
              "`j3-bots doctor` shows each provider's state.",
            ].join("\n"),
          );
      }
    }),
  ),
);

/**
 * How a harness's own sign-in runs for J3 Bots: its executable and arguments,
 * and this shell's environment with the harness's configuration folder set to
 * its J3-owned home. The sign-in is stored there, where the engine's instance
 * reads it, and the operator's own (`~/.claude`, `~/.codex`, or a folder this
 * shell names) is neither read nor written.
 */
export const signInCommand = (
  harness: Harness,
  executable: string,
  home: string,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const { signIn, homeVariable } = HARNESSES[harness];
  return { command: executable, args: signIn, env: { ...environment, [homeVariable]: home } };
};

const login = Command.make("login", {
  harness: Argument.Literals("harness", PROVIDER_HOMES).pipe(
    Argument.withDescription("The harness to sign in: claude-code or codex."),
  ),
}).pipe(
  Command.withDescription(
    "Sign Claude Code or Codex in with its own account, so bots on it reach its models without a provider connection. Runs the harness's own interactive sign-in with J3 Bots' home for it; your own sign-in and setup for that harness are neither read nor changed.",
  ),
  Command.withHandler(({ harness }) =>
    Effect.gen(function* () {
      const { name, executable, installPage } = HARNESSES[harness];
      const host = yield* Host;
      const found = yield* host.findExecutable(executable, host.searchPath);
      if (Option.isNone(found)) {
        return yield* refuse(
          `\`${executable}\` is not on PATH. Install ${name} as this user first: ${installPage}.`,
        );
      }
      // Only into a home the server would accept, which stays private.
      const config = yield* userFacing(ServerConfig.load);
      yield* userFacing(Home.checkPrivate(config.home));
      yield* userFacing(Home.checkWritable(config.home));
      const home = homeLayout(yield* Path.Path, config.home).providerHome(harness);
      const fs = yield* FileSystem.FileSystem;
      yield* userFacing(fs.makeDirectory(home, { recursive: true, mode: 0o700 }));

      const connection = yield* EngineLive.activeConnection(config.engineHome);
      if (connection !== null) {
        yield* Console.log(
          `A provider connection to ${connection} is stored, and J3 Bots sets ${name} up to reach its models through it, so ${name} may not use this sign-in while that connection stays.`,
        );
      }
      yield* Console.log(`Signing ${name} in for J3 Bots, in ${home}.`);
      const command = signInCommand(
        harness,
        found.value,
        home,
        yield* Effect.sync(() => process.env),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exitCode = yield* userFacing(
        spawner.exitCode(
          ChildProcess.make(command.command, [...command.args], {
            env: command.env,
            extendEnv: false,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        ),
      );
      if (exitCode !== 0) {
        return yield* refuse(`${name}'s sign-in ended with status ${exitCode}.`);
      }
      return yield* Console.log(
        [
          `${name}'s sign-in finished, in J3 Bots' home for it.`,
          `\`j3-bots doctor\` shows what the engine reports for ${name}. While it still shows ${name} signed out, the engine has not checked it again: \`systemctl --user restart j3-bots\` makes it check now, and stops the work bots have running.`,
        ].join("\n"),
      );
    }),
  ),
);

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription("How bots reach their models."),
  Command.withSubcommands([connect, login]),
);
