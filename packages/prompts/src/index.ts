// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/prompts`: everything a bot reads that J3 Bots writes.
 *
 * - {@link renderSystemFile}, {@link renderBaseInstructions} and
 *   {@link renderBotInstructions}: a bot's standing instructions, per harness.
 * - {@link renderWake}: the envelope every dispatched message is wrapped in.
 * - {@link tools} and {@link toolList}: the `j3` MCP tools, their descriptions
 *   and the schemas their arguments decode with.
 * - {@link PROMPT_VERSION}: one identifier for all of the above.
 *
 * Every function here is pure. `renderWake` draws its nonce from `SecureRandom`.
 */
export {
  type AskAnswer,
  type AttachmentRef,
  type BotWake,
  type CatchUpItem,
  type OperatorMessage,
  type ProfileChange,
  renderWake,
  type RoomEntry,
  type RoomMentions,
  type RoomWake,
  type RoutineRunSummary,
  type RoutineTrigger,
  type RoutineWake,
  type SystemEvent,
  type SystemWake,
  type TeammateMessage,
  type TeammateRef,
  type UserWake,
  type Wake,
  type WakeKind,
} from "./envelope.ts";
export {
  type BotInstructionsInput,
  type OperatorInfo,
  renderBaseInstructions,
  renderBotInstructions,
  renderSystemFile,
} from "./instructions.ts";
export {
  DECODE_OPTIONS,
  type McpTool,
  type ToolDefinition,
  type ToolInput,
  type ToolName,
  toolList,
  tools,
} from "./tools.ts";
export { PROMPT_VERSION } from "./version.ts";
