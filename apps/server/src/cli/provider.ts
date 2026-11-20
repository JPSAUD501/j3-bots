// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag, Prompt } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import { isProviderBaseUrl } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { refuse, userFacing } from "./errors.ts";

const NOT_RUNNING =
  "The server is not running, and it is the running server that hands the connection to the engine. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run this again.";

const REFUSED =
  "The engine's data refused the connection, so nothing changed. The server's log names the folder: `journalctl --user -u j3-bots`.";

/**
 * The base URL as the engine is given it, from what the operator typed: the
 * endpoint's root, without a trailing `/` or `/v1`, which each harness adds
 * itself. None when it is not an `http` or `https` URL without credentials,
 * query or fragment.
 */
export const normalizeBaseUrl = (text: string): Option.Option<string> => {
  const trimmed = text.trim().replace(/\/+$/, "");
  const root = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
  return isProviderBaseUrl(root) ? Option.some(root) : Option.none();
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

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription(
    "The endpoint's base URL, such as http://127.0.0.1:8317. It must speak Anthropic's Messages API and OpenAI's Responses API.",
  ),
);

const connect = Command.make("connect", { baseUrl: baseUrlFlag }).pipe(
  Command.withDescription(
    "Connect Claude Code and Codex to an endpoint that serves their models, such as a proxy in front of your subscriptions. Asks for its key, or reads it from standard input. The key is kept only in the engine's secret store.",
  ),
  Command.withHandler(({ baseUrl }) =>
    Effect.gen(function* () {
      const root = normalizeBaseUrl(baseUrl);
      if (Option.isNone(root)) {
        return yield* refuse(
          `${baseUrl} is not a base URL J3 Bots can use. Give an http or https URL with no user name, password, query or fragment, such as http://127.0.0.1:8317.`,
        );
      }
      const socket = yield* userFacing(ServerConfig.resolveAdminSocket);
      const admin = yield* AdminClient;
      if (Option.isNone(yield* userFacing(admin.status(socket)))) return yield* refuse(NOT_RUNNING);
      const key = yield* readKey.pipe(
        Effect.mapError(() => refuse("No key was read, so nothing changed.")),
      );
      if (key.length === 0) return yield* refuse("The key is empty, so nothing changed.");
      const answer = yield* userFacing(
        admin.connectProviders(socket, { baseUrl: root.value, key }),
      );
      if (Option.isNone(answer)) return yield* refuse(NOT_RUNNING);
      if (answer.value.outcome === "refused") return yield* refuse(REFUSED);
      yield* Console.log(
        [
          `Claude Code and Codex now reach their models through ${root.value}.`,
          "The engine picks the change up by itself. `j3-bots doctor` shows when each provider is ready.",
        ].join("\n"),
      );
    }),
  ),
);

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription("How bots reach their models."),
  Command.withSubcommands([connect]),
);
