// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decisions every client makes the same way before it draws anything:
 * roster order, timeline grouping, what a form may save, how a moment is
 * formatted. Free of any interface library and of the interface's sentences.
 */
export {
  avatarBusy,
  avatarFace,
  type AvatarContext,
  avatarMood,
  type AvatarMood,
  type AvatarNear,
  avatarNearness,
  type AvatarPoke,
  avatarSeed,
  type AvatarSim,
  type AvatarState,
  avatarStates,
  type AvatarTraits,
  createAvatar,
  notificationState,
  plainTraits,
  pointerNear,
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
export {
  addedFrom,
  addedPlace,
  applyConnectorChange,
  connectorNeedsYou,
  type ConnectorsOpening,
  connectorsOf,
  type ConnectorsPlace,
  connectorTone,
  type ConnectorTone,
  grantsBot,
  initialGrant,
  listingKey,
  listingPlace,
  sameGrant,
  type SignInProblem,
  withBot,
} from "./connectors.ts";
export {
  type ArgumentsDraft,
  type ClientInput,
  type CommandConsent,
  type CommandEdit,
  commandConsent,
  commandEdit,
  commandSource,
  type EnvProblem,
  fieldValues,
  type FormProblems,
  keepsLine,
  type KnownCommand,
  knownCommand,
  listingSource,
  withoutSecrets,
  type PairInput,
  remoteSource,
  type SourceDraft,
} from "./connectorForm.ts";
export { type CodeLineTone, diffTones } from "./diff.ts";
export {
  cannotRun,
  connectCommand,
  hasDefaultModel,
  installsHarnesses,
  type OpeningHold,
  openingHeld,
  type OwnHarness,
  ownHarness,
  providerFix,
  type ProviderFix,
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
  standingMentions,
} from "./mentions.ts";
export { type Inline, type MentionName, parseMessageText } from "./messageText.ts";
export {
  defaultBotName,
  FirstRunProgress,
  makingProgress,
  nextStep,
  type OnboardingFlow,
  type OnboardingStep,
  previousStep,
  resumedStep,
  showsConnect,
  type StageScene,
  stageScene,
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
  ROOM_MEMBERS,
  ROOM_NAME_MAX,
  roomChanges,
  roomDraft,
  type RoomFormMode,
  roomFormOf,
  roomFormStart,
  type RoomFormProblem,
  roomFormTarget,
  type RoomFormValues,
  sameRoomForm,
  withMember,
  withoutDeleted,
} from "./roomForm.ts";
export {
  buildPairTimeline,
  inPair,
  pairKeyText,
  pairMessageKey,
  type PairTimelineItem,
  peerOf,
  type Teammate,
  teammatesOf,
} from "./pairs.ts";
export {
  arrangedOrder,
  arrangeRoster,
  type ArrangedRoster,
  betweenBots,
  type BotItem,
  canStop,
  filterPairs,
  filterRoster,
  firstLine,
  memberStack,
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
  arrivalsSettled,
  keptPlaces,
  lifts,
  moveDelay,
  noArrivals,
  type RosterArrivals,
  rosterArrivals,
  rosterMotion,
  type RosterView,
  type RowMove,
  rowTops,
} from "./rosterMotion.ts";
export { shownSaveProblem } from "./saves.ts";
export { type Shared, sharedDraft, type SharedDraft, type SharedFile } from "./share.ts";
export { editsAfterFailedSave, noEdits, type SettingsEdits, settingsPatch } from "./settings.ts";
export { providersNeedYou, type SettingsPage, settingsGroups } from "./settingsPages.ts";
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
  type CardEntry,
  type EntryPlace,
  type EventLine,
  type EventLineOpens,
  eventLineOpens,
  handoffPeer,
  joinEventLines,
  latestOfLine,
  type LineSetting,
  type NonMessageEntry,
  placeOf,
  type RoutineChanges,
  type TeammateRun,
  type TeammateRunPair,
} from "./eventLine.ts";
export {
  type ArrivalCounts,
  arrivalCounts,
  arrivedRows,
  buildTimeline,
  type CardPlace,
  cardPlace,
  type GroupPosition,
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
export {
  type Arrival,
  arrival,
  landingPage,
  LOOPBACK_HEADERS,
  type LoopbackAnswer,
  type LoopbackRequest,
  type SignInCatch,
  signInCatch,
} from "./signInReturn.ts";
export {
  CONNECTOR_APP_BRIDGE,
  CONNECTOR_APP_DEFAULT_HEIGHT,
  CONNECTOR_APP_FRAME_SANDBOX,
  type ConnectorAppAsk,
  type ConnectorAppHost,
  type ConnectorAppHostOptions,
  type ConnectorAppPlace,
  clampConnectorAppHeight,
  connectorAppDocument,
  connectorAppHost,
  connectorAppShell,
  fromOwnFrame,
  type HostMessage,
} from "./connectorApp.ts";
export { typedOrigins } from "./secrets.ts";
export {
  readVisualHeight,
  type VisualAppearance,
  VISUAL_BRIDGE,
  VISUAL_FRAME_SANDBOX,
  VISUAL_HEIGHT_MESSAGE,
  visualDocument,
  visualShell,
} from "./visual.ts";
export {
  type InstallDraft,
  type InstallProblem,
  installedName,
  newSkillText,
  sameScope,
  skillDraft,
  type SkillGroup,
  skillGroups,
  skillInstall,
} from "./skills.ts";
export {
  type InputDraft,
  type InputProblem,
  inputContent,
  inputDrafts,
  inputProblem,
} from "./connectorInput.ts";
export { type PromptOption, promptArguments, promptOptions, promptQuery } from "./prompts.ts";
