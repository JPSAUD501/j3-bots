// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2GetThreadProjectionError, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isMissingThread } from "./missingThread.ts";

// The engine's errors under the names it gives them (**Read** at `db51b67`,
// `ProjectionStore.ts` and `Orchestrator.ts`): a read of a thread fails with
// the orchestrator's error, caused by the projection store's.
class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  { threadId: ThreadId },
) {}
class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {}
class OrchestratorProjectionError extends Schema.TaggedError<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {}

const threadId = ThreadId.make("j3-session-1");

/** The error as the adapter receives it: encoded by the engine, decoded by the client. */
const received = (cause: unknown) =>
  Schema.decodeSync(OrchestrationV2GetThreadProjectionError)(
    Schema.encodeSync(OrchestrationV2GetThreadProjectionError)(
      new OrchestrationV2GetThreadProjectionError({
        threadId,
        message: `Failed to load orchestration V2 thread ${threadId}`,
        cause,
      }),
    ),
  );

describe("isMissingThread", () => {
  it("is true only when the engine has no record of the thread", () => {
    assert.isTrue(
      isMissingThread(
        received(
          new OrchestratorProjectionError({
            threadId,
            cause: new ProjectionStoreThreadNotFoundError({ threadId }),
          }),
        ),
      ),
    );
  });

  it("leaves a failed projection read or replay retryable", () => {
    // The database was busy: the next read may succeed.
    assert.isFalse(
      isMissingThread(
        received(
          new OrchestratorProjectionError({
            threadId,
            cause: new ProjectionStoreReadError({ threadId, cause: new Error("SQLITE_BUSY") }),
          }),
        ),
      ),
    );
    // A replay that could not read the event store.
    assert.isFalse(isMissingThread(received(new Error("database is locked"))));
    assert.isFalse(isMissingThread(received(undefined)));
  });
});
