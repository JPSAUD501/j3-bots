// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SessionId } from "./ids.ts";

// The engine starts each harness with the session's thread id in its
// environment, and the harness passes it on to the stdio MCP servers it starts.
// **Verified** on Claude Code and, from release 4969, on Codex.
const THREAD_ID_VARIABLE = "T3CODE_THREAD_ID";

const decodeSessionId = Schema.decodeUnknownOption(SessionId);

/**
 * The session a bot tool call comes from, read from the environment the
 * harness started the `j3` bridge process with. `None` when the process was
 * not started by an engine session.
 */
export const sessionOfToolCaller = (
  environment: Readonly<Record<string, string | undefined>>,
): Option.Option<SessionId> => decodeSessionId(environment[THREAD_ID_VARIABLE]);
