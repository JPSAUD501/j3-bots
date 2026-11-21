// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decisions every client makes the same way before it draws anything:
 * roster order, timeline grouping, what a form may save, how a moment is
 * formatted. Free of any interface library and of the interface's sentences.
 */
export {
  type AvatarAppearance,
  avatarAppearance,
  type AvatarBadge,
  type AvatarMark,
} from "./avatar.ts";
export {
  type BotEdits,
  type BotPatch,
  botPatch,
  editsAfterFailedBotSave,
  type ModelChoices,
  modelChoices,
  noBotEdits,
  type ProfileField,
  sameModel,
  withChanges,
  withProfileEdit,
} from "./botEdit.ts";
export { firstSeen, see, type Seen } from "./changes.ts";
export { type CodeLineTone, diffTones } from "./diff.ts";
export { webAddress } from "./links.ts";
export {
  addressed,
  type Addressee,
  addresseeOf,
  type DraggedText,
  draggedText,
  type EditPlace,
  EVERYONE,
  type FieldEdit,
  followEdit,
  followInput,
  insertMention,
  type Mentionable,
  mentionedNames,
  mentionedWhoLeft,
  type MentionOption,
  mentionOptions,
  type MentionQuery,
  mentionQuery,
  movedOption,
} from "./mentions.ts";
export {
  type Block,
  endsAt,
  type Inline,
  literalRanges,
  opensAt,
  parseMessageText,
} from "./messageText.ts";
export { assembleAnswers, type QuestionDraft } from "./question.ts";
export {
  blankRoomForm,
  followRoom,
  hostOf,
  ROOM_MEMBERS,
  ROOM_NAME_MAX,
  roomChanges,
  roomDraft,
  type RoomFormContext,
  roomFormContext,
  type RoomFormMode,
  roomFormOf,
  type RoomFormProblem,
  roomFormTarget,
  type RoomFormValues,
  sameRoomForm,
  withMember,
  withoutDeleted,
} from "./roomForm.ts";
export { canStop, filterRoster, orderRoster, rosterKeyOf, rosterKeyText } from "./roster.ts";
export { type SaveProblem, shownSaveProblem } from "./saves.ts";
export { type CronSchedule, readCron, type TimeOfDay } from "./schedule.ts";
export {
  editsAfterFailedSave,
  noEdits,
  type SettingsEdits,
  type SettingsPatch,
  settingsPatch,
} from "./settings.ts";
export {
  calendarDaysAgo,
  clockTime,
  formatAt,
  formatMoment,
  fullTime,
  type LocalTime,
  millisBetween,
  shortDuration,
} from "./time.ts";
export {
  buildTimeline,
  type GroupPosition,
  handoffPeer,
  type TimelineItem,
  type TimelineMessage,
} from "./timeline.ts";
export {
  type BotSpend,
  type Coverage,
  coverage,
  type ProviderUsage,
  providerUsage,
} from "./usage.ts";
