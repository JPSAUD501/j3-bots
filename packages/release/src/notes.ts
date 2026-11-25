// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_HIGHLIGHT_LENGTH, MAX_HIGHLIGHTS } from "@j3-bots/contracts";

// What a release brings, in a few lines a client can show before it is
// installed, read from its notes as docs/releases/TEMPLATE.md has them
// written: under the "What's new" heading, each item opens with its gist in
// bold. Only those bold leads are taken, in order: the notes say the rest.

/** The "What's new" heading, at level two; the apostrophe straight or curly. */
const WHATS_NEW = /^##\s+What['’]s new\s*$/i;
/** A heading at level one or two, which ends the section. */
const SECTION_END = /^#{1,2}\s/;
/** An item at the list's top level whose text opens in bold. */
const LEAD = /^[-*]\s+\*\*(.+?)\*\*/;

/** `text` without Markdown's links and code marks, and its spaces made one. */
const plain = (text: string): string =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** `text` within the length a highlight may have, cut at a word with an ellipsis. */
const bounded = (text: string): string => {
  if (text.length <= MAX_HIGHLIGHT_LENGTH) return text;
  const cut = text.slice(0, MAX_HIGHLIGHT_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The highlights of a release from `body`, its notes in Markdown as the
 * releases page has them: at most `MAX_HIGHLIGHTS`. None when the notes have
 * no "What's new" section, or no item in it opens in bold.
 */
export const highlightsOf = (body: string | null | undefined): ReadonlyArray<string> => {
  if (body === null || body === undefined) return [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => WHATS_NEW.test(line));
  if (start === -1) return [];
  const highlights: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    const lead = LEAD.exec(line)?.[1];
    if (lead === undefined) continue;
    const text = plain(lead);
    if (text.length === 0) continue;
    highlights.push(bounded(text));
    if (highlights.length === MAX_HIGHLIGHTS) break;
  }
  return highlights;
};
