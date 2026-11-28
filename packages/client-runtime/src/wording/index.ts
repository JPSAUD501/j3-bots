// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The interface's sentences every client says the same way: a roster row's
 * line, a notice, a delivery line, why a file cannot go, a time in words.
 * Built from the catalog in `@j3-bots/i18n`, free of any interface library.
 */
export { resendLabel } from "./addressee.ts";
export { botNames, liveLine, tabLineWords, type TabLineWords, tabOpenFailed } from "./browser.ts";
export {
  CARD_ROOMS,
  type CardLines,
  cardLines,
  type CardRoom,
  type CardStatus,
  cardStatus,
} from "./card.ts";
export { type AnsweringLine, answeringLine } from "./answering.ts";
export {
  connectFailureText,
  connectorStatusText,
  type ConnectorStatusText,
  envProblemText,
  grantText,
  pinRefusalText,
  publisherText,
  secretRefusalText,
  serverText,
  signedInText,
  signInProblemText,
} from "./connectors.ts";
export {
  avatarShapeText,
  botColorText,
  botModelName,
  effortText,
  memoryEditProblemText,
  memoryFileName,
  permissionModeText,
  type RoutineLines,
  routineLines,
  type RoutineRunLines,
  routineRunLines,
  templateReadText,
  templateTooLargeText,
} from "./details.ts";
export {
  type EventIcon,
  type EventLead,
  type EventLineWords,
  eventLineWords,
  type EventMark,
  type EventRun,
  handoffMarks,
  routineChangeDetail,
} from "./eventLine.ts";
export {
  engineDownload,
  engineProblem,
  harnessFailureText,
  harnessOutcomeText,
  harnessTaskText,
  type ProviderPlace,
  providerLine,
  type ProviderTone,
  providerVersionLine,
} from "./engine.ts";
export {
  deliveryLine,
  draftFileDetail,
  fileDetail,
  fileProblemText,
  fileSize,
  messageProblemText,
  type RefusedMentions,
} from "./message.ts";
export {
  heldHelloText,
  type LineTone,
  memberList,
  noticeText,
  type PresentationContext,
  presenceLine,
  quietConversationText,
  rosterLine,
  type StatusLine,
  usageLimitText,
} from "./status.ts";
export {
  type AiAccountContext,
  type AiAccountText,
  aiAccountName,
  aiAccountText,
  aiActionLabel,
  type AiTone,
  connectStepText,
  type ConnectStepText,
} from "./aiAccount.ts";
export {
  type LineName,
  type NamedLine,
  pairLine,
  pairOrder,
  pairTitle,
  teammateChoice,
  type TeamNotice,
  teamNoticeLine,
} from "./pairs.ts";
export {
  deviceZoneOffer,
  eventInWords,
  eventStopText,
  scheduleInWords,
  timeZoneHint,
  triggerInWords,
} from "./schedule.ts";
export { secretsFailureText, secretsStateText } from "./secrets.ts";
export { settingsPageWords } from "./settings.ts";
export {
  CLOUD_PROVIDER_KEY_PAGES,
  CLOUD_PROVIDER_NAMES,
  dictationBlockWords,
  dictationFailureNeedsSetup,
  dictationFailureWords,
  elapsedWords,
  languageName,
} from "./voice.ts";
export { activityTime, dividerTime, type TimeContext, timeInSentence } from "./time.ts";
export { windowText, type WindowText } from "./usage.ts";
export { type Announcement, turnAnnouncement, turnLine } from "./turn.ts";
export { littleOneText, planStepText, planTitle } from "./plan.ts";
export { fillDetail, fillText, stepDetail, stepMark, stepText, workFoldTitle } from "./work.ts";
export {
  type ServerUpdateLine,
  serverUpdateLine,
  startRefusalText,
  type UpdateTone,
  serverBehindLine,
  serverFailureLine,
  updateResultLine,
} from "./update.ts";
export { lastChangeText, skillFailureText, skillScopeText, skillSourceText } from "./skills.ts";
export {
  botStationSub,
  botStationTitle,
  conditionTitle,
  endReason,
  failureHelp,
  foldLine,
  keyedRuns,
  routineSentence,
  type SentenceRun,
  sentenceText,
  stationStateText,
  trackTag,
  youStationLines,
} from "./routine.ts";
export { themeDescription, themeMakerText, themeName } from "./themes.ts";
