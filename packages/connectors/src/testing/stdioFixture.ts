// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Where the fixture server is, and whether a process still runs, are Node's to say.
import * as NodeOs from "node:os";
import * as NodeUrl from "node:url";
import { InMemoryResponseCacheStore } from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { CommandSessionOptions } from "../command/session.ts";
import type { McpSession } from "../session.ts";
import { DEFAULT_SESSION_LIMITS } from "../session.ts";

/**
 * The tiny MCP server tests start as a command connector (`stdioServer.ts`),
 * run with this Node, and what tests ask of the processes it makes.
 */

/** The fixture server's file. */
export const STDIO_SERVER = NodeUrl.fileURLToPath(new URL("./stdioServer.ts", import.meta.url));

/** A value the operator gives the fixture in its environment. */
export const OPERATOR_SECRET = "op-secret-4f3e2d1c0b";

/** A variable only the server's own environment has, which no command may see. */
export const SERVER_ONLY = "J3_TEST_SERVER_ONLY";

/** The server's environment as tests give it: the real one, and a variable of its own. */
export const serverEnvironment: Readonly<Record<string, string | undefined>> = {
  ...process.env,
  [SERVER_ONLY]: "the-servers-own-value",
};

/** What the supervisor's tests start: the fixture, with a secret, and `args` after its file. */
export const fixtureOptions = (
  args: ReadonlyArray<string> = [],
): Omit<CommandSessionOptions, "onListChanged"> => ({
  platform: process.platform,
  program: process.execPath,
  args: [STDIO_SERVER, ...args].map((arg) => Redacted.make(arg)),
  variables: [{ name: "FIXTURE_SECRET", value: Redacted.make(OPERATOR_SECRET) }],
  hidden: [],
  carried: [],
  serverEnvironment,
  cwd: NodeOs.tmpdir(),
  limits: DEFAULT_SESSION_LIMITS,
  client: { name: "j3-bots-test", version: "0.0.0" },
  cache: new InMemoryResponseCacheStore(),
});

/** The text of the tool's answer. */
export const answerOf = (
  session: McpSession,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
) => session.callTool({ name, arguments: args }).pipe(Effect.map((answer) => answer.text));

/** Whether the process `pid` still runs. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until `holds` does, asked again and again for at most ten seconds, then fails. */
export const eventually = <E, R>(holds: Effect.Effect<boolean, E, R>) =>
  holds.pipe(
    Effect.repeat({ schedule: Schedule.spaced(Duration.millis(50)), until: (done) => done }),
    Effect.timeout(Duration.seconds(10)),
  );
