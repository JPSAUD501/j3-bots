// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

// Engine identifiers are opaque to the rest of J3 Bots. Their values are stable,
// so the server stores them, but nothing outside this package may parse them.

const opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** The engine project behind one bot's workspace folder. */
export const EngineProjectId = opaque.pipe(Schema.brand("EngineProjectId"));
export type EngineProjectId = typeof EngineProjectId.Type;

/**
 * A session: the engine thread that holds a bot's working context. Its value is
 * the engine's thread id, which is also what identifies the caller of a bot
 * tool (see `sessionOfToolCaller`). The server stores it next to its own id for
 * the session and never derives one from the other.
 */
export const SessionId = opaque.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** One turn of a session, from the first token to the point where it stops. */
export const TurnId = opaque.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

/** An approval, a question or a secret request the engine is holding a turn on. */
export const RequestId = opaque.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

/**
 * A position in one session's event stream. Store the cursor of the last event
 * applied, and pass it back to resume after a restart.
 */
export const EventCursor = opaque.pipe(Schema.brand("EventCursor"));
export type EventCursor = typeof EventCursor.Type;

/**
 * Makes an engine command safe to repeat. The engine applies a key once; sending
 * it again returns the first outcome. Use a durable id the server already owns
 * for the intent, written before the command is sent: the session's own id for
 * `openSession`, the dispatch id for `dispatch`. Every engine identifier the
 * adapter sends for the command (the command id, the message id, the thread id
 * of a new session) is derived from the key, so a retry after a crash sends the
 * same command. Keys are global: never reuse one for another command.
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;
