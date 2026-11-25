// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";

/**
 * A name a message highlights where `@` opens it, and whose it is: a member's,
 * or `@everyone`'s, which is no bot's.
 */
export interface MentionName {
  readonly name: string;
  readonly botId: BotId | null;
}

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly text: string }
  | { readonly kind: "mention"; readonly name: string; readonly botId: BotId | null }
  /** The message's file of this index, where the operator placed it. */
  | { readonly kind: "file"; readonly index: number };

export type Block =
  | { readonly kind: "paragraph"; readonly inlines: ReadonlyArray<Inline> }
  | { readonly kind: "code"; readonly language: string | null; readonly text: string };

const FENCE = /^```([\w+-]*)\n([\s\S]*?)\n?```$/gm;
// Inline code, or a web link. A link stops at a backtick, which opens code.
const LITERAL = /`([^`\n]+)`|(https?:\/\/[^\s<>"`]+)/gu;
const TRAILING = /[.,;:!?'"]+$/;

/** A part of message text read as it is written: a fenced block, inline code or a link. */
type Literal =
  | {
      readonly kind: "fence";
      readonly start: number;
      readonly end: number;
      readonly language: string | null;
      readonly text: string;
    }
  | {
      readonly kind: "inline";
      readonly start: number;
      readonly end: number;
      readonly inline: Inline;
    };

/**
 * The literal parts of `text`, in order and apart: fenced blocks, and between
 * them inline code and web links. One reading, which the bubble renders and
 * the composer judges mentions by, so they never disagree.
 */
function literals(text: string): ReadonlyArray<Literal> {
  const found: Array<Literal> = [];
  const inline = (from: number, to: number) => {
    for (const match of text.slice(from, to).matchAll(LITERAL)) {
      const [whole, code, url] = match;
      const start = from + match.index;
      if (code !== undefined) {
        found.push({
          kind: "inline",
          start,
          end: start + whole.length,
          inline: { kind: "code", text: code },
        });
      } else if (url !== undefined) {
        let href = url.replace(TRAILING, "");
        // A closing parenthesis belongs to the link only if the link opened one.
        while (href.endsWith(")") && count(href, "(") < count(href, ")")) href = href.slice(0, -1);
        found.push({
          kind: "inline",
          start,
          end: start + href.length,
          inline: { kind: "link", href, text: href },
        });
      }
    }
  };
  let cursor = 0;
  for (const fence of text.matchAll(FENCE)) {
    inline(cursor, fence.index);
    found.push({
      kind: "fence",
      start: fence.index,
      end: fence.index + fence[0].length,
      language: fence[1] || null,
      text: fence[2] ?? "",
    });
    cursor = fence.index + fence[0].length;
  }
  inline(cursor, text.length);
  return found;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * Where `text` is read as written, so an `@` there mentions nobody: each
 * fenced block, inline code span and web link, as `[start, end)`.
 */
export function literalRanges(text: string): ReadonlyArray<readonly [number, number]> {
  return literals(text).map(({ start, end }) => [start, end] as const);
}

/**
 * A mention opens at the start of the text, after a space, after opening
 * punctuation or after a file placed in a draft (`FILE_MARK`), so an address
 * like `ana@example.com` holds none.
 */
export const opensAt = (text: string, at: number) =>
  at === 0 || /[\s([{"'“‘«:\uFFFC]/u.test(text.charAt(at - 1));

/** A name ends where the text does or where no letter, digit or underscore follows. */
export const endsAt = (text: string, at: number) => !/[\p{L}\p{N}\p{M}_]/u.test(text.charAt(at));

/** A file placed in the text: its index among the message's files, and where it stands. */
interface Placed {
  readonly index: number;
  readonly at: number;
}

/**
 * Splits message text into what the bubble renders: paragraphs with inline
 * code, links and mentions, and fenced code blocks. Everything else is plain
 * text. Only http and https addresses become links. `@` and a name in
 * `mentionable` is a mention, of the bot the name is, where it opens and ends
 * as one, outside code and links; of two names that both fit, the longer, and
 * of two bots of one name, the first.
 *
 * Each of `placed`, a file's offset in the text by its index, never
 * decreasing, becomes a `file` inline where it stands: in its paragraph,
 * after a code span, link or mention it would split, and, between
 * paragraphs or blocks, in a paragraph of the files placed there.
 */
export function parseMessageText(
  text: string,
  mentionable: ReadonlyArray<MentionName> = [],
  placed: ReadonlyArray<number> = [],
): Block[] {
  const names = mentionable
    .filter(({ name }) => name !== "")
    .toSorted((a, b) => b.name.length - a.name.length);
  const parts = literals(text);
  // A file inside a literal stands after it.
  const files: ReadonlyArray<Placed> = placed.map((offset, index) => {
    const at = Math.min(Math.max(offset, 0), text.length);
    const inside = parts.find((part) => part.start < at && at < part.end);
    return { index, at: inside === undefined ? at : inside.end };
  });
  const blocks: Block[] = [];
  const alone = (group: ReadonlyArray<Placed>) => {
    if (group.length === 0) return;
    blocks.push({
      kind: "paragraph",
      inlines: group.map(({ index }) => ({ kind: "file", index })),
    });
  };
  /** The paragraphs of `[from, to]`, with the files that stand there, `to` included. */
  const paragraphs = (from: number, to: number) => {
    const ranges: Array<readonly [number, number]> = [];
    const split = (start: number, end: number) => {
      while (start < end && text[start] === "\n") start += 1;
      while (end > start && text[end - 1] === "\n") end -= 1;
      if (text.slice(start, end).trim() !== "") ranges.push([start, end]);
    };
    let start = from;
    for (const gap of text.slice(from, to).matchAll(/\n{2,}/g)) {
      split(start, from + gap.index);
      start = from + gap.index + gap[0].length;
    }
    split(start, to);
    let here = files.filter(({ at }) => at >= from && at <= to);
    for (const [start, end] of ranges) {
      alone(here.filter(({ at }) => at < start));
      const inline = here.filter(({ at }) => at >= start && at <= end);
      here = here.filter(({ at }) => at > end);
      blocks.push({
        kind: "paragraph",
        inlines: inlines(
          text,
          start,
          end,
          parts.filter((part) => part.kind === "inline" && part.start >= start && part.end <= end),
          names,
          inline,
        ),
      });
    }
    alone(here);
  };
  let cursor = 0;
  for (const part of parts) {
    if (part.kind !== "fence") continue;
    paragraphs(cursor, part.start);
    blocks.push({ kind: "code", language: part.language, text: part.text });
    cursor = part.end;
  }
  paragraphs(cursor, text.length);
  return blocks;
}

/**
 * The inlines of `[from, to)` of `text`: its literal parts, and mentions and
 * text between them, with each of `files`, standing in `[from, to]`, where it
 * stands: before a part or mention it starts at, after one it would split.
 */
function inlines(
  text: string,
  from: number,
  to: number,
  parts: ReadonlyArray<Literal>,
  names: ReadonlyArray<MentionName>,
  files: ReadonlyArray<Placed>,
): Inline[] {
  const out: Inline[] = [];
  const waiting = [...files];
  const pushText = (s: string) => {
    if (s === "") return;
    const last = out.at(-1);
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + s };
    else out.push({ kind: "text", text: s });
  };
  /** Plain text of `[start, end)`, with the files that stand up to `end`. */
  const plain = (start: number, end: number) => {
    let cursor = start;
    for (let next = waiting[0]; next !== undefined && next.at <= end; next = waiting[0]) {
      waiting.shift();
      const at = Math.max(next.at, cursor);
      pushText(text.slice(cursor, at));
      out.push({ kind: "file", index: next.index });
      cursor = at;
    }
    pushText(text.slice(cursor, end));
  };
  const prose = (start: number, end: number) => {
    let cursor = start;
    for (let at = text.indexOf("@", start); at !== -1 && at < end; at = text.indexOf("@", at + 1)) {
      if (at < cursor || !opensAt(text, at)) continue;
      const found = names.find(
        ({ name }) =>
          at + 1 + name.length <= end &&
          text.startsWith(name, at + 1) &&
          endsAt(text, at + 1 + name.length),
      );
      if (found === undefined) continue;
      plain(cursor, at);
      out.push({ kind: "mention", name: found.name, botId: found.botId });
      cursor = at + 1 + found.name.length;
    }
    plain(cursor, end);
  };
  let cursor = from;
  for (const part of parts) {
    if (part.kind !== "inline") continue;
    prose(cursor, part.start);
    out.push(part.inline);
    cursor = part.end;
  }
  prose(cursor, to);
  return out;
}
