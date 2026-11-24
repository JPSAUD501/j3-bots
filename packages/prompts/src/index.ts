// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/prompts`: everything a bot reads that J3 Bots writes.
 *
 * - {@link renderSystemFile}, {@link renderBaseInstructions} and
 *   {@link renderBotInstructions}: a bot's standing instructions, per harness.
 * - {@link renderWake}: the envelope every dispatched message is wrapped in.
 * - {@link tools} and {@link toolList}: the `j3` MCP tools, their descriptions
 *   and the schemas their arguments decode with, within
 *   {@link MAX_TOOL_INPUT_BYTES}; {@link NO_TURN_REFUSAL}: what a call that
 *   matches no running turn, such as a subagent's, reads;
 *   {@link BROWSER_HELP_REQUESTED}: what a request for help in the browser
 *   answers; and {@link SUGGESTION_SHOWN} and {@link SUGGESTION_REFUSED}:
 *   what a connector suggestion answers.
 * - {@link sharedSkills}: the skills J3 Bots ships, which the server installs
 *   for every bot.
 * - {@link renderConnectorResult}: what a bot reads back from a connector's
 *   tool, framed as untrusted data; {@link connectorToolDescription}: a
 *   connector tool's description, after a line saying whose it is;
 *   {@link defuseTags}, for other remote text a bot reads.
 * - {@link PROMPT_VERSION}: one identifier for all of the above.
 *
 * Every function here is pure. `renderWake` and `renderConnectorResult` draw their nonce from `SecureRandom`.
 */
export {
  type AskAnswer,
  type AttachmentRef,
  type BotWake,
  type CatchUpItem,
  type DigestMessage,
  type OperatorMessage,
  type ProfileChange,
  renderWake,
  renderWakeForSize,
  ROOM_CLOSING_LINES,
  type RoomEntry,
  type RoomMentions,
  type RoomReason,
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
  BROWSER_HELP_REQUESTED,
  DECODE_OPTIONS,
  FILL_NOTES,
  MAX_BOTS_PER_TURN,
  MAX_TOOL_INPUT_BYTES,
  inputCapRefusal,
  isConnectorTool,
  type McpTool,
  NO_TURN_REFUSAL,
  SUGGESTION_REFUSED,
  SUGGESTION_SHOWN,
  type ToolDefinition,
  type ToolInput,
  type ToolName,
  toolList,
  tools,
} from "./tools.ts";
export {
  type ConnectorResult,
  type ConnectorUnavailable,
  connectorToolDescription,
  renderConnectorResult,
} from "./connectorResult.ts";
export { type SharedSkill, sharedSkills } from "./skills.ts";
export { defuseTags } from "./text.ts";
export { PROMPT_VERSION } from "./version.ts";
