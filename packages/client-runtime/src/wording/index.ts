// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The interface's sentences every client says the same way: a roster row's
 * line, a notice, a delivery line, why a file cannot go, a time in words.
 * Built from the catalog in `@j3-bots/i18n`, free of any interface library.
 */
export { addresseeLine, resendLabel } from "./addressee.ts";
export {
  botModelName,
  memoryEditProblemText,
  memoryFileName,
  permissionModeText,
  type RoutineLines,
  routineLines,
} from "./details.ts";
export { engineProblem, providerLine, type ProviderTone } from "./engine.ts";
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
export { scheduleInWords } from "./schedule.ts";
export {
  activityTime,
  dividerTime,
  type TimeContext,
  timeInSentence,
  upcomingTime,
} from "./time.ts";
export { windowText, type WindowText } from "./usage.ts";
export { stepText, workFoldTitle } from "./work.ts";
