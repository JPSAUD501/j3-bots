// SPDX-License-Identifier: AGPL-3.0-or-later
import { admitFiles, type FileProblem, normalizeMediaType } from "../files/limits.ts";

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
  /**
   * What the sharing app called the link, as a page's title: only what it
   * handed over with the share. The page is never fetched to find one.
   */
  readonly title: string | null;
  readonly files: ReadonlyArray<SharedFile>;
}

/** The message a share becomes, sent to the bot the operator picked. */
export interface SharedMessage {
  /** Its text, empty when the share is files alone and no line was added. */
  readonly text: string;
  /** The shared files the message takes, in order: each to read and upload. */
  readonly uploads: ReadonlyArray<SharedFile>;
  /**
   * The shared files it leaves out, in order, each with why: the reason the
   * composer gives for a file picked there that breaks the same limit.
   */
  readonly leftOut: ReadonlyArray<{ readonly file: SharedFile; readonly problem: FileProblem }>;
}

/**
 * The shared text, then the link: on a line of its own unless the text
 * already holds it, under its title when the sharing app gave one the text
 * does not already hold.
 */
const sharedText = ({ text, url, title }: Shared) => {
  const said = text?.trim() ?? "";
  const link = url?.trim() ?? "";
  if (link === "" || said.includes(link)) return said;
  const named = title?.trim() ?? "";
  const heading = named === "" || said.includes(named) || named === link ? "" : named;
  return [said, heading, link].filter((part) => part !== "").join("\n");
};

/**
 * The message what another app shared becomes: the line the operator added
 * above it first, then a blank line and the shared text and link. The text is
 * kept whole whatever its length: as with text typed into the composer, the
 * send says when the message is too long. The files are admitted by the rule
 * `attach` applies to files picked in the composer, with the media type the
 * server will store: a file the message takes is to be uploaded, one it does
 * not is left out with the reason.
 */
export const sharedMessage = (shared: Shared, line: string): SharedMessage => {
  const text = [line.trim(), sharedText(shared)].filter((part) => part !== "").join("\n\n");
  const problems = admitFiles(
    [],
    shared.files.map((file) => ({
      name: file.name,
      mediaType: normalizeMediaType(file.mediaType),
      size: file.size,
    })),
  );
  const uploads: Array<SharedFile> = [];
  const leftOut: Array<SharedMessage["leftOut"][number]> = [];
  shared.files.forEach((file, index) => {
    const problem = problems[index] ?? null;
    if (problem === null) uploads.push(file);
    else leftOut.push({ file, problem });
  });
  return { text, uploads, leftOut };
};
