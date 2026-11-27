// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * MCP's Tasks extension (`io.modelcontextprotocol/tasks`, on 2026-07-28): a
 * server may answer a `tools/call` with a task it keeps running, which the
 * client polls with `tasks/get`, answers with `tasks/update` when it needs
 * input, and stops with `tasks/cancel`.
 *
 * The SDK J3 Bots uses declares the extension but neither reads a task
 * result (it rejects the call as of a result type it does not know) nor
 * sends `tasks/*` on a 2026-07-28 connection: J3 Bots speaks it on its tap
 * of the session's transport (`tap.ts`).
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The `_meta` key a call is tagged with, so its answer can be told from others'. */
export const CALL_TAG = "j3-bots/call";

const TaskStatus = Schema.Literals([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
type TaskStatus = typeof TaskStatus.Type;

/** A task as the server first answered with it, or as `tasks/get` gives it now. */
export const Task = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: TaskStatus,
  statusMessage: Schema.optionalKey(Schema.String),
  /** How long the server keeps the task after it was created, in milliseconds; null for no bound. */
  ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  pollIntervalMs: Schema.optionalKey(Schema.Finite),
});
export type Task = typeof Task.Type;

const CreatedTask = Schema.Struct({ ...Task.fields, resultType: Schema.Literal("task") });
/** A call's answer as the task it runs as, when it is one. */
export const decodeCreatedTask = Schema.decodeUnknownOption(CreatedTask);

/** What a server asks for while a task waits on input: requests keyed by the name its answers go back under. */
const InputRequests = Schema.Record(
  Schema.String,
  Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
);

/** A task as `tasks/get` details it: with its input requests, its result, or its error. */
export const DetailedTask = Schema.Struct({
  ...Task.fields,
  inputRequests: Schema.optionalKey(InputRequests),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int, message: Schema.String })),
});
export type DetailedTask = typeof DetailedTask.Type;
