// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MessageProblem, messageProblem } from "../files/limits.ts";
import type { DraftFile } from "../stores/Drafts.ts";

/** Where a draft stands before Send: what it would take for the message to go. */
export interface DraftReadiness {
  /** No text and no uploaded file: nothing to send, so the trailing button may dictate instead. */
  readonly empty: boolean;
  /** A file is still uploading; the message waits for it. */
  readonly uploading: boolean;
  /** A file cannot go, and holds the message until the operator removes it. */
  readonly blocked: boolean;
  /** Why the message cannot go as it is, past any one file. */
  readonly problem: MessageProblem | null;
  /** Send hands the draft over now, unless the composer takes no change at the moment. */
  readonly sendable: boolean;
}

export function draftReadiness(text: string, files: ReadonlyArray<DraftFile>): DraftReadiness {
  const trimmed = text.trim();
  const attachments = files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : []));
  const empty = trimmed === "" && attachments.length === 0;
  const uploading = files.some((file) => file._tag === "uploading");
  const blocked = files.some((file) => file._tag === "failed");
  const problem = messageProblem(trimmed, attachments);
  return {
    empty,
    uploading,
    blocked,
    problem,
    sendable: !empty && !uploading && !blocked && problem === null,
  };
}

/** A file's name in the composer, whether it is uploading, uploaded or refused. */
export const draftFileName = (file: DraftFile): string =>
  file._tag === "ready" ? file.attachment.name : file.name;
