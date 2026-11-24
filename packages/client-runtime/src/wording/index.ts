// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The interface's sentences every client says the same way: a roster row's
 * line, a notice, a delivery line, why a file cannot go, a time in words.
 * Built from the catalog in `@j3-bots/i18n`, free of any interface library.
 */
export { addresseeLine, resendLabel } from "./addressee.ts";
export {
  connectedText,
  connectFailureText,
  connectorStatusText,
  type ConnectorStatusText,
  envProblemText,
  grantText,
  pinRefusalText,
  publisherText,
  signedInText,
  signInProblemText,
} from "./connectors.ts";
export {
  avatarShapeText,
  botColorText,
  botModelName,
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
export { engineDownload, engineProblem, providerLine, type ProviderTone } from "./engine.ts";
export {
  deliveryLine,
  draftFileDetail,
  fileDetail,
  fileProblemText,
  fileSize,
  messageProblemText,
} from "./message.ts";
export {
  entrySummary,
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
export { connectStepText, type ConnectStepText } from "./onboarding.ts";
export {
  type LineName,
  type NamedLine,
  pairLine,
  pairOrder,
  pairTitle,
  teammateChoice,
  type TeamLineContext,
  type TeamNotice,
  teamNoticeLine,
} from "./pairs.ts";
export { endpointInstead, type SignInLine, signInLine } from "./providerSetup.ts";
export { deviceZoneOffer, scheduleInWords, timeZoneHint } from "./schedule.ts";
export {
  activityTime,
  dividerTime,
  type TimeContext,
  timeInSentence,
  upcomingTime,
} from "./time.ts";
export { windowText, type WindowText } from "./usage.ts";
export { type Announcement, turnAnnouncement, turnLabel, turnLine } from "./turn.ts";
export { unlockWaitsUntil, vaultFailureText } from "./vault.ts";
export { fillDetail, stepText, workFoldTitle } from "./work.ts";
export {
  type ServerUpdateLine,
  serverUpdateLine,
  startRefusalText,
  type UpdateTone,
  serverBehindLine,
  updateResultLine,
} from "./update.ts";
