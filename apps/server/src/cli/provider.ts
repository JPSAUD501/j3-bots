// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag, Prompt } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import { providerBaseUrlProblem } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
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
  const trimmed = text.trim().replace(/\/+$/, "");
  const root = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
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
    return yield* refuse(
      `${flag.value} is not a base URL J3 Bots can use: ${root.problem}. ${EXAMPLES}`,
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

const connect = Command.make("connect", { baseUrl: baseUrlFlag }).pipe(
  Command.withDescription(
    "Connect Claude Code and Codex to an endpoint that serves their models, such as a proxy in front of your subscriptions. Asks for its base URL unless given, then for its key, or reads the key from standard input. The key is kept only in the engine's secret store.",
  ),
  Command.withHandler(({ baseUrl }) =>
    Effect.gen(function* () {
      const url = yield* readBaseUrl(baseUrl);
      const socket = yield* userFacing(ServerConfig.resolveAdminSocket);
      const admin = yield* AdminClient;
      if (Option.isNone(yield* userFacing(admin.status(socket)))) return yield* refuse(NOT_RUNNING);
      const key = yield* readKey.pipe(
        Effect.mapError(() => refuse("No key was read, so nothing changed.")),
      );
      if (key.length === 0) return yield* refuse("The key is empty, so nothing changed.");
      const answer = yield* userFacing(admin.connectProviders(socket, { baseUrl: url, key }));
      if (Option.isNone(answer)) return yield* refuse(NOT_RUNNING);
      const outcome = answer.value;
      switch (outcome._tag) {
        case "refused":
          return yield* refuse(refused(outcome.active));
        case "recorded":
          return yield* Console.log(
            [
              `The connection to ${outcome.baseUrl} is stored, but the engine's settings could not be written. The server's log says why: \`journalctl --user -u j3-bots\`.`,
              "The engine takes it when it next starts: `systemctl --user restart j3-bots`.",
            ].join("\n"),
          );
        case "active":
          return yield* Console.log(
            [
              `Claude Code and Codex reach their models through ${outcome.baseUrl} from the next time each starts.`,
              "One already running keeps the connection it started with, and Codex runs one process for all its work. To put every bot on this connection now, restart J3 Bots: `systemctl --user restart j3-bots`. That stops any work a bot has running.",
              "`j3-bots doctor` shows when each provider is ready.",
            ].join("\n"),
          );
      }
    }),
  ),
);

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription("How bots reach their models."),
  Command.withSubcommands([connect]),
);
