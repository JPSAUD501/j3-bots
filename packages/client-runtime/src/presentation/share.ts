// SPDX-License-Identifier: AGPL-3.0-or-later
import { admitFiles, type FileProblem, normalizeMediaType } from "../files/limits.ts";
import { type Draft, type DraftMention, heldFiles } from "../stores/Drafts.ts";

/** A file another app shared, as the platform describes it. */
export interface SharedFile {
  readonly name: string;
  /** As the platform gives it; empty when it gives none. */
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
  /** Where the platform keeps it, to read it from once it is to be uploaded. */
  readonly uri: string;
}

/** What another app shared with J3 Bots. */
export interface Shared {
  readonly text: string | null;
  readonly url: string | null;
  readonly files: ReadonlyArray<SharedFile>;
}

/** What sharing does to the draft of the bot or room the operator picked. Nothing is sent. */
export interface SharedDraft {
  /** The draft's new text, with `mentions`: what `setText` takes. */
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  /** The shared files the draft takes, in order: each to read and `attach`. */
  readonly uploads: ReadonlyArray<SharedFile>;
  /**
   * The shared files it leaves out, in order, each with why: the reason the
   * composer gives for a file picked there that breaks the same limit.
   */
  readonly leftOut: ReadonlyArray<{ readonly file: SharedFile; readonly problem: FileProblem }>;
}

/** The shared text, then its URL on a line of its own unless the text already holds it. */
const sharedText = ({ text, url }: Shared) => {
  const said = text?.trim() ?? "";
  const link = url?.trim() ?? "";
  const parts = link === "" || said.includes(link) ? [said] : [said, link];
  return parts.filter((part) => part !== "").join("\n");
};

/**
 * Puts what another app shared into `draft`, the draft of the bot or room
 * the operator picked, which may already hold writing and files. The shared
 * text follows what the draft holds, after a blank line, so nothing written
 * there is lost and the mentions picked in it stand where they were. It is
 * kept whole whatever its length: as with text typed into the composer, Send
 * says when the message is too long. The files are admitted against those the
 * draft already holds, by the rule `attach` applies to files picked in the
 * composer, with the media type the server will store: a file the draft
 * takes is to be uploaded, one it does not is left out with the reason.
 */
export const sharedDraft = (draft: Draft | undefined, shared: Shared): SharedDraft => {
  const written = draft?.text ?? "";
  const added = sharedText(shared);
  const kept = written.trim() !== "";
  const text = added === "" ? written : kept ? `${written.trimEnd()}\n\n${added}` : added;
  const mentions = added === "" || kept ? (draft?.mentions ?? []) : [];
  const problems = admitFiles(
    heldFiles(draft),
    shared.files.map((file) => ({
      name: file.name,
      mediaType: normalizeMediaType(file.mediaType),
      size: file.size,
    })),
  );
  const uploads: Array<SharedFile> = [];
  const leftOut: Array<SharedDraft["leftOut"][number]> = [];
  shared.files.forEach((file, index) => {
    const problem = problems[index] ?? null;
    if (problem === null) uploads.push(file);
    else leftOut.push({ file, problem });
  });
  return { text, mentions, uploads, leftOut };
};
