// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention } from "../stores/Drafts.ts";

/**
 * The character that stands for a file in a draft's text: Unicode's object
 * replacement character, which a field draws the file's chip over. A draft's
 * text holds one for each of its files, in the order of its files, so where
 * a mark stands is where its file goes in the message. Text typed or pasted
 * never brings one: a field writes it only for a file, and drops any other.
 */
export const FILE_MARK = "￼";

/** How many files `text` places. */
export const markCount = (text: string): number => text.split(FILE_MARK).length - 1;

/** Where each mark stands in `text`, in order. */
export function markPositions(text: string): ReadonlyArray<number> {
  const positions: Array<number> = [];
  for (let at = text.indexOf(FILE_MARK); at !== -1; at = text.indexOf(FILE_MARK, at + 1)) {
    positions.push(at);
  }
  return positions;
}

/** Text and the mentions picked in it, which move with it. */
export interface Writing {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
}

/**
 * `writing` without the marks `drop` picks, by their index among the marks,
 * each mention moved back by the marks taken out before it.
 */
export function withoutMarks(writing: Writing, drop: (index: number) => boolean): Writing {
  const dropped = markPositions(writing.text).filter((_, index) => drop(index));
  if (dropped.length === 0) return writing;
  let text = "";
  let cursor = 0;
  for (const at of dropped) {
    text += writing.text.slice(cursor, at);
    cursor = at + 1;
  }
  text += writing.text.slice(cursor);
  const mentions = writing.mentions.map((mention) => ({
    ...mention,
    position: mention.position - dropped.filter((at) => at < mention.position).length,
  }));
  return { text, mentions };
}

/**
 * `writing` placing exactly `count` files: marks past `count` go, from the
 * last, and missing ones are added at the end, for files a draft holds that
 * its text does not place, as one kept before drafts placed files.
 */
export function fittedMarks(writing: Writing, count: number): Writing {
  const marks = markCount(writing.text);
  if (marks > count) return withoutMarks(writing, (index) => index >= count);
  if (marks < count) return { ...writing, text: writing.text + FILE_MARK.repeat(count - marks) };
  return writing;
}

/**
 * `writing` with `count` marks written at `at`, clamped into the text, and
 * the index the first of their files takes among the draft's files: the
 * number of marks before them.
 */
export function insertMarks(
  writing: Writing,
  at: number,
  count: number,
): Writing & { readonly index: number } {
  const place = Math.min(Math.max(at, 0), writing.text.length);
  return {
    text: writing.text.slice(0, place) + FILE_MARK.repeat(count) + writing.text.slice(place),
    mentions: writing.mentions.map((mention) =>
      mention.position >= place ? { ...mention, position: mention.position + count } : mention,
    ),
    index: markCount(writing.text.slice(0, place)),
  };
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * What a draft sends: its text without marks, trimmed as a message is, and
 * where each of its files stands in that text, by its mark, as
 * `message.send`'s `attachmentOffsets` take them. A file placed in the space
 * trimmed away stands at the edge of the text.
 */
export function placedMessage(draftText: string): {
  readonly text: string;
  readonly offsets: ReadonlyArray<number>;
} {
  let stripped = "";
  const places: Array<number> = [];
  let cursor = 0;
  for (const at of markPositions(draftText)) {
    stripped += draftText.slice(cursor, at);
    places.push(stripped.length);
    cursor = at + 1;
  }
  stripped += draftText.slice(cursor);
  const lead = stripped.length - stripped.trimStart().length;
  const text = stripped.trim();
  const offsets = places.map((place) => {
    const offset = Math.min(Math.max(place - lead, 0), text.length);
    // A mark the field let between the halves of a character goes after it.
    return offset > 0 &&
      offset < text.length &&
      isHigh(text.charCodeAt(offset - 1)) &&
      isLow(text.charCodeAt(offset))
      ? offset + 1
      : offset;
  });
  return { text, offsets };
}
