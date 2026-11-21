// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decisions every client makes the same way before it draws anything:
 * roster order, timeline grouping, what a form may save, how a moment is
 * formatted. Free of any interface library and of the interface's sentences.
 */
export { avatarAppearance, notificationLook } from "./avatar.ts";
export {
  type BotEdits,
  botPatch,
  editsAfterFailedBotSave,
  modelChoices,
  noBotEdits,
  type ProfileField,
  sameModel,
  withChanges,
  withProfileEdit,
} from "./botEdit.ts";
export { firstSeen, see } from "./changes.ts";
export { type CodeLineTone, diffTones } from "./diff.ts";
export { webAddress } from "./links.ts";
export {
  addressed,
  type Addressee,
  addresseeOf,
  draggedText,
  type DraggedText,
  EVERYONE,
  type FieldEdit,
  followFieldEdit,
  insertMention,
  type Mentionable,
  mentionedNames,
  mentionedWhoLeft,
  type MentionOption,
  mentionOptions,
  mentionQuery,
  movedOption,
} from "./mentions.ts";
export { type Inline, parseMessageText } from "./messageText.ts";
export {
  notificationOpening,
  type NotificationOpening,
  type OpenedNotification,
  pushOpening,
} from "./notificationOpening.ts";
export { assembleAnswers, type QuestionDraft } from "./question.ts";
export {
  blankRoomForm,
  followRoom,
  hostOf,
  ROOM_MEMBERS,
  ROOM_NAME_MAX,
  roomChanges,
  roomDraft,
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
export {
  canStop,
  filterRoster,
  firstLine,
  orderRoster,
  roomStop,
  type RoomStop,
  roomStopFailed,
  rosterKeyOf,
  rosterKeyText,
} from "./roster.ts";
export { shownSaveProblem } from "./saves.ts";
export { type Shared, sharedDraft, type SharedDraft, type SharedFile } from "./share.ts";
export { minuteText, readCron, timeOfDayText, weekdayList, zoneName } from "./schedule.ts";
export { editsAfterFailedSave, noEdits, type SettingsEdits, settingsPatch } from "./settings.ts";
export {
  calendarDaysAgo,
  clockTime,
  formatAt,
  fullTime,
  type LocalTime,
  millisBetween,
  shortDuration,
} from "./time.ts";
export {
  buildTimeline,
  type GroupPosition,
  handoffPeer,
  type TimelineMessage,
} from "./timeline.ts";
export {
  type BotSpend,
  coverage,
  providerUsage,
  type ProviderUsage,
  type WindowState,
  windowState,
} from "./usage.ts";
