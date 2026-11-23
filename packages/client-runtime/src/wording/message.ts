// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
  MAX_MESSAGE_LENGTH,
} from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { FileProblem, MessageProblem } from "../files/limits.ts";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
import type { OpeningHold } from "../presentation/engine.ts";
import { fileKind } from "../presentation/files.ts";
import type { DraftFile } from "../stores/Drafts.ts";
import type { MessageStatus } from "../stores/Conversations.ts";
import { timeInSentence, type TimeContext } from "./time.ts";

const failedKeys = {
  rejected: "message.failed.rejected",
  unresolved: "message.failed.unresolved",
  stopped: "message.failed.stopped",
} as const satisfies Record<Extract<MessageStatus, { _tag: "failed" }>["reason"], KeyWith>;

const notSentKeys = {
  refused: "message.notSent.refused",
  "not-paired": "message.notSent.notPaired",
  unexpected: "message.notSent.unexpected",
} as const satisfies Record<IntentFailure["_tag"], KeyWith>;

const statusKey = (status: MessageStatus, submitting: boolean): KeyWith | null => {
  switch (status._tag) {
    case "sending":
      return "message.sending";
    case "not-sent":
      // Too long for the bot's engine is the one refusal the client cannot foresee and the operator can act on.
      return refusedWith(status.failure, "message-length")
        ? "message.notSent.tooLong"
        : notSentKeys[status.failure._tag];
    case "unrecorded":
      return "message.unrecorded";
    case "queued":
      return "message.queued";
    case "delivered":
      return null;
    case "cancelled":
      return "message.cancelled";
    case "failed":
      // A retry on its way reads as queued again, which it is about to be.
      return submitting ? "message.queued" : failedKeys[status.reason];
  }
};

/** When a message behind the bot's hello goes, as what holds the hello says. */
const behindOpeningText = (hold: OpeningHold, ctx: TimeContext): string => {
  const { t } = ctx.i18n;
  if (hold._tag !== "limit") return t("message.waitingForModel");
  return hold.resetsAt === null
    ? t("message.waitingForReset")
    : t("message.waitingForResetAt", { when: timeInSentence(hold.resetsAt, ctx) });
};

/**
 * What the operator reads under their message, or null when there is nothing
 * to say. `submitting`: a retry is on its way. `leftRoom`: the members the
 * message mentions who have left the room, for which the server refused it,
 * said in place of the refusal. `openingHold`: what holds the bot's hello
 * back (`openingHeld`), which a message the server says waits behind it
 * (`behindOpening`) waits for too; any other message reads as queued.
 */
export function deliveryLine(
  status: MessageStatus,
  {
    submitting,
    leftRoom,
    openingHold,
  }: {
    readonly submitting: boolean;
    readonly leftRoom: ReadonlyArray<string>;
    readonly openingHold: OpeningHold | null;
  },
  ctx: TimeContext,
): string | null {
  const { i18n } = ctx;
  if (status._tag === "not-sent" && leftRoom.length > 0) {
    return i18n.plural("message.notSent.left", leftRoom.length, {
      names: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(leftRoom),
    });
  }
  if (status._tag === "queued" && status.behindOpening === true && openingHold !== null) {
    return behindOpeningText(openingHold, ctx);
  }
  const key = statusKey(status, submitting);
  return key === null ? null : i18n.t(key);
}

/**
 * A size in bytes, in the operator's language: "1.2 MB", or "178 bytes" and
 * "1 byte" in words, since the short unit for a byte is not plural ("178 byte").
 */
export function fileSize(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: unit === 0 ? "long" : "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** A file's kind and size under its name: "PDF · 1.2 MB", or the size alone. */
export function fileDetail(
  file: { readonly mediaType: string; readonly size: number },
  { t, locale }: I18n,
): string {
  const kind = fileKind(file.mediaType);
  const size = fileSize(file.size, locale);
  return kind === "" ? size : t("file.kindAndSize", { kind, size });
}

/** Why a file cannot go, in one sentence. */
export function fileProblemText(problem: FileProblem, { t, locale }: I18n): string {
  switch (problem) {
    case "empty":
      return t("composer.file.empty");
    case "too-large":
      return t("composer.file.tooLarge", { size: fileSize(MAX_ATTACHMENT_SIZE, locale) });
    case "image-too-large":
      return t("composer.file.imageTooLarge", { size: fileSize(MAX_INLINE_IMAGE_SIZE, locale) });
    case "images-too-large":
      return t("composer.file.imagesTooLarge", { size: fileSize(MAX_INLINE_IMAGES_SIZE, locale) });
    case "too-many":
      return t("composer.file.tooMany", { count: String(MAX_ATTACHMENTS_PER_MESSAGE) });
    case "name-too-long":
      return t("composer.file.nameTooLong");
    case "refused":
      return t("composer.file.refused");
    case "server-setup":
      return t("composer.file.serverSetup");
    case "not-paired":
      return t("composer.file.notPaired");
  }
}

/** Why the message cannot go as it is, in one sentence. */
export function messageProblemText(problem: MessageProblem, i18n: I18n): string {
  const { t, locale } = i18n;
  const count = new Intl.NumberFormat(locale);
  switch (problem) {
    case "too-long":
      return t("composer.tooLong", { count: count.format(MAX_MESSAGE_LENGTH) });
    case "too-many-files":
      return t("composer.tooManyFiles", { count: count.format(MAX_ATTACHMENTS_PER_MESSAGE) });
    case "empty-file":
      return t("composer.filesProblem", { reason: fileProblemText("empty", i18n) });
    case "image-too-large":
    case "images-too-large":
      return t("composer.filesProblem", { reason: fileProblemText(problem, i18n) });
  }
}

/**
 * How a file in the draft fares, beside its name. `progress`: whether this
 * device can tell how much of an upload has gone; without it, an upload only
 * says it is under way.
 */
export function draftFileDetail(
  file: DraftFile,
  i18n: I18n,
  { progress }: { readonly progress: boolean },
): string {
  const { t, locale } = i18n;
  switch (file._tag) {
    case "uploading":
      return progress
        ? t("composer.file.uploading", {
            percent: new Intl.NumberFormat(locale, { style: "percent" }).format(
              file.size === 0 ? 0 : file.sent / file.size,
            ),
          })
        : t("composer.file.uploadingUnmeasured");
    case "ready":
      return fileSize(file.attachment.size, locale);
    case "failed":
      return fileProblemText(file.problem, i18n);
  }
}
