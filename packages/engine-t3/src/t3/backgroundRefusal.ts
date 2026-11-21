// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OrchestrationV2DispatchCommandError } from "@t3tools/contracts";

/**
 * The words of the engine's refusal to change a session's model or permission
 * mode while the provider session the change replaces runs background work.
 * No class name tells this refusal from others, so its message is all there
 * is. **Read** at `db51b67`: `Orchestrator.ts` L4744-4757 and
 * `ClaudeAdapterV2.ts` L831 word it, and `ws.ts`
 * (`userFacingDispatchErrorMessage`) makes it the reply's message. Its test
 * holds the wording at the pin, which a new pin checks against the engine's
 * source again.
 */
const BACKGROUND_REFUSAL = "still running background agents or commands";

/** Whether a refused command was refused over background work it would end. */
export const isBackgroundWorkRefusal = (error: OrchestrationV2DispatchCommandError): boolean =>
  error.message.includes(BACKGROUND_REFUSAL);
