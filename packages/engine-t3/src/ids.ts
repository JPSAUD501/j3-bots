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
 * A file staged in the engine for a dispatch, as `Engine.stageAttachment`
 * returned it. The engine mints this id itself; store it with the dispatch so a
 * retry sends the same file without uploading it again.
 */
export const EngineAttachmentId = opaque.pipe(Schema.brand("EngineAttachmentId"));
export type EngineAttachmentId = typeof EngineAttachmentId.Type;

/**
 * One use of the host's own speech tool in a turn. Stable: a `replaced` may list
 * speech the server already applied, and this is how it tells.
 */
export const HostSpeechId = opaque.pipe(Schema.brand("HostSpeechId"));
export type HostSpeechId = typeof HostSpeechId.Type;

/**
 * The caller's name for one `Engine.synchronize` call, echoed by the
 * `synchronized` event it produces.
 */
export const SyncToken = opaque.pipe(Schema.brand("SyncToken"));
export type SyncToken = typeof SyncToken.Type;

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
 * `openSession`, the dispatch id for `dispatch`, a key derived from the Stop
 * command and the session for `stop`. Every engine identifier the
 * adapter sends for the command (the command id, the message id, the thread id
 * of a new session) is derived from the key, so a retry after a crash sends the
 * same command. Keys are global: never reuse one for another command.
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;
