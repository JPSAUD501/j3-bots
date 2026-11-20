// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { SessionId, ToolInputDigest } from "./ids.ts";

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

/** JSON with every object's keys in one order, so equal inputs give equal text. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key: string, member: unknown): unknown =>
    Predicate.isObject(member)
      ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : member,
  );

/**
 * The digest of a tool call's input, as `tool-call` events carry it. The tool
 * bridge computes it from the arguments of the call it received, and the
 * adapter from the input the engine recorded for the call; equal inputs give
 * equal digests whatever the order of their keys. A missing input counts as `{}`.
 */
export const toolInputDigest = (input: unknown): Effect.Effect<ToolInputDigest> =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const hex = yield* digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode(canonicalJson(input ?? {})),
    );
    return ToolInputDigest.make(hex);
  }).pipe(Effect.provide(Digest.layerWebCrypto));
