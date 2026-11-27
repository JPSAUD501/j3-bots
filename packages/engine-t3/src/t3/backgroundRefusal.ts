// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OrchestrationV2DispatchCommandError } from "@t3tools/contracts";

/**
 * The words of the engine's refusal to change a session's model or permission
 * mode while the provider session the change replaces runs background work.
 * No class name tells this refusal from others, so its message is all there
 * is. **Read** at `bc0f04d`: `Orchestrator.ts` L4900-4913 and
 * `ClaudeAdapterV2.ts` L929 word it, and `ws.ts`
 * (`userFacingDispatchErrorMessage`) makes it the reply's message. The
 * engine's refusal to settle a thread over such work (L4779) and to start a
 * fresh session or switch provider over it (L8618-8619) share the words; the
 * adapter reads this only from a change of model or permission mode, and
 * J3 Bots never settles a session. Its test holds the wording at the pin,
 * which a new pin checks against the engine's source again.
 */
const BACKGROUND_REFUSAL = "still running background agents or commands";

/** Whether a refused command was refused over background work it would end. */
export const isBackgroundWorkRefusal = (error: OrchestrationV2DispatchCommandError): boolean =>
  error.message.includes(BACKGROUND_REFUSAL);
