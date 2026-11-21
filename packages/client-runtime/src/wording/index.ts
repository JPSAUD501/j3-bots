// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The interface's sentences every client says the same way: a roster row's
 * line, a notice, a delivery line, why a file cannot go, a time in words.
 * Built from the catalog in `@j3-bots/i18n`, free of any interface library.
 */
export { addresseeLine, resendLabel } from "./addressee.ts";
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
  rosterLine,
  type StatusLine,
  usageLimitText,
  workFoldTitle,
} from "./status.ts";
export {
  activityTime,
  dividerTime,
  type TimeContext,
  timeInSentence,
  upcomingTime,
} from "./time.ts";
