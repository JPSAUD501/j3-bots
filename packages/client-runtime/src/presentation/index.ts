// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decisions every client makes the same way before it draws anything:
 * roster order, timeline grouping, what a form may save, how a moment is
 * formatted. Free of any interface library and of the interface's sentences.
 */
export {
  avatarFace,
  type AvatarContext,
  type AvatarGaze,
  avatarMood,
  type AvatarMood,
  type AvatarPoke,
  avatarSeed,
  type AvatarSim,
  type AvatarState,
  avatarStates,
  type AvatarTraits,
  createAvatar,
  gazeToward,
  notificationState,
  plainTraits,
  pokeAvatar,
  setAvatarState,
  speakingUntil,
  stepAvatar,
  stillFace,
} from "./avatar.ts";
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
export {
  type DrawnRect,
  dragWheel,
  frontTab,
  type PageSize,
  pagePoint,
  type Point,
  siteOf,
} from "./browser.ts";
export { type CodeLineTone, diffTones } from "./diff.ts";
export {
  connectCommand,
  hasDefaultModel,
  type OpeningHold,
  openingHeld,
  providerGate,
} from "./engine.ts";
export { draftFileName, draftReadiness, type DraftReadiness } from "./draft.ts";
export {
  FILE_MARK,
  fittedMarks,
  insertMarks,
  markCount,
  markPositions,
  placedMessage,
  withoutMarks,
} from "../files/placed.ts";
export { type FileIcon, fileIcon, fileKind, showsImage } from "./files.ts";
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
  defaultBotName,
  makingProgress,
  nextStep,
  type OnboardingStep,
  previousStep,
  showsConnect,
} from "./onboarding.ts";
export {
  notificationOpening,
  type NotificationOpening,
  type OpenedNotification,
  pushOpening,
} from "./notificationOpening.ts";
export { assembleAnswers, optionDescription, type QuestionDraft } from "./question.ts";
export {
  blankRoomForm,
  followRoom,
  hopLimitSteps,
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
  arrangedOrder,
  arrangeRoster,
  type ArrangedRoster,
  type BotItem,
  canStop,
  filterRoster,
  firstLine,
  orderRoster,
  roomStop,
  type RoomStop,
  roomStopFailed,
  rosterKeyOf,
  rosterKeyText,
  type RosterSectionRows,
  rosterTarget,
} from "./roster.ts";
export {
  keptPlaces,
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
  rowTops,
} from "./rosterMotion.ts";
export { shownSaveProblem } from "./saves.ts";
export { type Shared, sharedDraft, type SharedDraft, type SharedFile } from "./share.ts";
export { editsAfterFailedSave, noEdits, type SettingsEdits, settingsPatch } from "./settings.ts";
export {
  isTemplateFileName,
  openTemplateChunks,
  openTemplateFile,
  readTemplateFile,
  sharedTemplate,
  templateFileName,
  templateFileTooLarge,
  type TemplateModel,
  type TemplateRead,
  type TemplateStart,
  templateStart,
  type TemplateSubmission,
  templateSubmission,
} from "./template.ts";
export {
  calendarDaysAgo,
  clockTime,
  formatAt,
  fullTime,
  knownTimeZone,
  type LocalTime,
  millisBetween,
  shortDuration,
} from "./time.ts";
export {
  type ArrivalCounts,
  arrivalCounts,
  arrivedRows,
  buildTimeline,
  type GroupPosition,
  handoffPeer,
  readThrough,
  rowOrder,
  type TimelineItem,
  type TimelineMessage,
  turnKey,
} from "./timeline.ts";
export {
  foldOfTurn,
  liveTurn,
  type LiveTurn,
  turnClock,
  turnElapsed,
  withLiveTurn,
} from "./turn.ts";
export {
  type BotSpend,
  coverage,
  providerUsage,
  type ProviderUsage,
  type WindowState,
  windowState,
} from "./usage.ts";
