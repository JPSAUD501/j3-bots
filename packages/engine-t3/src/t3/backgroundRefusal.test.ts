// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { CommandId, OrchestrationV2DispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isBackgroundWorkRefusal } from "./backgroundRefusal.ts";

// The engine's words at the pin (**Read** at `db51b67`): the orchestrator's
// refusal of a settings change, and the Claude adapter's own.
const ORCHESTRATOR =
  "The current session is still running background agents or commands, and this change would end them. Wait for them to finish, or press Stop, then try again.";
const CLAUDE =
  "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.";

/** The reply as the adapter receives it: encoded by the engine, decoded by the client. */
const received = (message: string) =>
  Schema.decodeSync(OrchestrationV2DispatchCommandError)(
    Schema.encodeSync(OrchestrationV2DispatchCommandError)(
      new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("j3:mode:session-1:1"),
        commandType: "thread.runtime-mode.set",
        message,
        detail: message,
        cause: new Error(message),
      }),
    ),
  );

describe("isBackgroundWorkRefusal", () => {
  it("knows the pinned engine's refusals over background work", () => {
    assert.isTrue(isBackgroundWorkRefusal(received(ORCHESTRATOR)));
    assert.isTrue(isBackgroundWorkRefusal(received(CLAUDE)));
  });

  it("leaves any other refusal to the caller", () => {
    assert.isFalse(
      isBackgroundWorkRefusal(received("Failed to dispatch orchestration V2 command")),
    );
  });
});
