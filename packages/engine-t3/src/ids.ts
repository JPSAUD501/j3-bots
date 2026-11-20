import * as Schema from "effect/Schema";

// Engine identifiers are opaque to the rest of J3 Bots. Their values are stable,
// so the server stores them, but nothing outside this package may parse them.

const opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** The engine project behind one bot's workspace folder. */
export const EngineProjectId = opaque.pipe(Schema.brand("EngineProjectId"));
export type EngineProjectId = typeof EngineProjectId.Type;

/** A session: the engine thread that holds a bot's working context. */
export const SessionId = opaque.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** One turn of a session, from the first token to the point where it stops. */
export const TurnId = opaque.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

/** A step inside a turn: a command, an edit, a search, a delegated task. */
export const StepId = opaque.pipe(Schema.brand("StepId"));
export type StepId = typeof StepId.Type;

/** An approval or a question the engine is holding a turn on. */
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
 * for the intent, such as the wake id for a dispatch, so a retry after a crash
 * cannot do the work twice. Keys are global: never reuse one for another command.
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;
