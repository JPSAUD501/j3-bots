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
 *   answers; {@link SECRET_ASK_SHOWN} and {@link SECRET_ASK_EXISTS}: what an
 *   ask for a secret answers; {@link MANAGEMENT_NOTES} and
 *   {@link MANAGEMENT_REFUSED}: what the MCP server and skill tools answer;
 *   and {@link preApprovedTools}: the tools that run without asking.
 * - {@link renderRoomRead}: what `read_room` answers; {@link renderRoomMovedOn}:
 *   why a post to a room that moved on since the bot last saw it went out
 *   nowhere, with what it missed. Both frame room entries as envelopes do.
 * - {@link sharedSkills}: the skills J3 Bots ships, which the server installs
 *   for every bot.
 * - {@link renderConnectorResult}: what a bot reads back from a connector's
 *   tool, framed as untrusted data; {@link connectorToolDescription}: a
 *   connector tool's description, after a line saying whose it is;
 *   {@link defuseTags}, for other remote text a bot reads.
 * - {@link PROMPT_VERSION}: one identifier for all of the above.
 *
 * Every function here is pure. `renderWake`, `renderConnectorResult` and the room renders draw their nonce from `SecureRandom`.
 */
export {
  type AskAnswer,
  type AttachmentRef,
  type BotWake,
  type CatchUpItem,
  type DigestMessage,
  LOOKING_AT_APP_LINE,
  LOOKING_AT_WINDOW_LINE,
  type LookingAtRef,
  type OperatorMessage,
  type ProfileChange,
  renderWake,
  renderWakeForSize,
  ROOM_CLOSING_LINES,
  ROOM_CLOSING_NOTE,
  ROOM_NEWCOMER_LINE,
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
  MAX_BOTS_PER_REQUEST,
  MAX_TOOL_INPUT_BYTES,
  inputCapRefusal,
  isConnectorTool,
  MANAGEMENT_NOTES,
  MANAGEMENT_REFUSED,
  type McpTool,
  NO_TURN_REFUSAL,
  ROOM_READ_COUNT,
  SECRET_ASK_EXISTS,
  SECRET_ASK_SHOWN,
  type ToolDefinition,
  type ToolInput,
  type ToolName,
  preApprovedTools,
  toolList,
  tools,
} from "./tools.ts";
export {
  CONNECTOR_UNAVAILABLE,
  type ConnectorData,
  type ConnectorResult,
  type ConnectorUnavailable,
  connectorToolDescription,
  type ListedPrompt,
  type ListedResource,
  listingText,
  MAX_LISTING_CHARACTERS,
  NOTHING_LISTED,
  renderConnectorResult,
} from "./connectorResult.ts";
export {
  renderRoomMovedOn,
  renderRoomRead,
  ROOM_READ_LIMIT,
  type RoomMovedOn,
  roomMovedOnFits,
  type RoomRead,
  type RoomReadAuthor,
  type RoomReadEntry,
  roomReadFits,
} from "./roomRead.ts";
export { sharedSkills } from "./skills.ts";
export { defuseTags } from "./text.ts";
export { PROMPT_VERSION } from "./version.ts";
