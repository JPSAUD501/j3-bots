// SPDX-License-Identifier: AGPL-3.0-or-later
export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly text: string }
  | { readonly kind: "mention"; readonly name: string };

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
 * A mention opens at the start of the text, after a space or after opening
 * punctuation, so an address like `ana@example.com` holds none.
 */
export const opensAt = (text: string, at: number) =>
  at === 0 || /[\s([{"'“‘«:]/u.test(text.charAt(at - 1));

/** A name ends where the text does or where no letter, digit or underscore follows. */
export const endsAt = (text: string, at: number) => !/[\p{L}\p{N}\p{M}_]/u.test(text.charAt(at));

/**
 * Splits message text into what the bubble renders: paragraphs with inline
 * code, links and mentions, and fenced code blocks. Everything else is plain
 * text. Only http and https addresses become links. `@` and a name in
 * `mentionable` is a mention where it opens and ends as one, outside code and
 * links; of two names that both fit, the longer.
 */
export function parseMessageText(text: string, mentionable: ReadonlyArray<string> = []): Block[] {
  const names = mentionable.filter((name) => name !== "").toSorted((a, b) => b.length - a.length);
  const blocks: Block[] = [];
  const parts = literals(text);
  const paragraphs = (from: number, to: number) => {
    const split = (start: number, end: number) => {
      while (start < end && text[start] === "\n") start += 1;
      while (end > start && text[end - 1] === "\n") end -= 1;
      if (text.slice(start, end).trim() === "") return;
      blocks.push({
        kind: "paragraph",
        inlines: inlines(
          text,
          start,
          end,
          parts.filter((part) => part.kind === "inline" && part.start >= start && part.end <= end),
          names,
        ),
      });
    };
    let start = from;
    for (const gap of text.slice(from, to).matchAll(/\n{2,}/g)) {
      split(start, from + gap.index);
      start = from + gap.index + gap[0].length;
    }
    split(start, to);
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

/** The inlines of `[from, to)` of `text`: its literal parts, and mentions and text between them. */
function inlines(
  text: string,
  from: number,
  to: number,
  parts: ReadonlyArray<Literal>,
  names: ReadonlyArray<string>,
): Inline[] {
  const out: Inline[] = [];
  const pushText = (s: string) => {
    if (s === "") return;
    const last = out.at(-1);
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + s };
    else out.push({ kind: "text", text: s });
  };
  const prose = (start: number, end: number) => {
    let cursor = start;
    for (let at = text.indexOf("@", start); at !== -1 && at < end; at = text.indexOf("@", at + 1)) {
      if (at < cursor || !opensAt(text, at)) continue;
      const name = names.find(
        (candidate) =>
          at + 1 + candidate.length <= end &&
          text.startsWith(candidate, at + 1) &&
          endsAt(text, at + 1 + candidate.length),
      );
      if (name === undefined) continue;
      pushText(text.slice(cursor, at));
      out.push({ kind: "mention", name });
      cursor = at + 1 + name.length;
    }
    pushText(text.slice(cursor, end));
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
