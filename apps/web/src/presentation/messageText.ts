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
// Inline code, a web link, or an @mention.
const INLINE = /`([^`\n]+)`|(https?:\/\/[^\s<>"]+)|@([\p{L}\p{N}_-]+)/gu;
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Splits message text into what the bubble renders: paragraphs with inline
 * code, links and mentions, and fenced code blocks. Everything else is plain
 * text. Only http and https addresses become links. `@Name` is a mention only
 * when the name is in `mentionable`.
 */
export function parseMessageText(text: string, mentionable: ReadonlyArray<string> = []): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  for (const fence of text.matchAll(FENCE)) {
    paragraphs(text.slice(cursor, fence.index), mentionable, blocks);
    blocks.push({ kind: "code", language: fence[1] || null, text: fence[2] ?? "" });
    cursor = fence.index + fence[0].length;
  }
  paragraphs(text.slice(cursor), mentionable, blocks);
  return blocks;
}

function paragraphs(text: string, mentionable: ReadonlyArray<string>, into: Block[]) {
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.replace(/^\n+|\n+$/g, "");
    if (trimmed.trim() !== "")
      into.push({ kind: "paragraph", inlines: inlines(trimmed, mentionable) });
  }
}

function inlines(text: string, mentionable: ReadonlyArray<string>): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  const pushText = (s: string) => {
    if (s === "") return;
    const last = out.at(-1);
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + s };
    else out.push({ kind: "text", text: s });
  };
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, url, name] = match;
    pushText(text.slice(cursor, match.index));
    cursor = match.index + whole.length;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (url !== undefined) {
      let href = url.replace(TRAILING, "");
      // A closing parenthesis belongs to the link only if the link opened one.
      while (href.endsWith(")") && count(href, "(") < count(href, ")")) href = href.slice(0, -1);
      out.push({ kind: "link", href, text: href });
      cursor -= url.length - href.length;
    } else if (name !== undefined && (name === "everyone" || mentionable.includes(name))) {
      out.push({ kind: "mention", name });
    } else pushText(whole);
  }
  pushText(text.slice(cursor));
  return out;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

const INLINE_CODE = /`[^`\n]+`/g;

/**
 * Where `text` holds code, as a bubble renders it: each fenced block and each
 * inline span, from its first backtick to its last, as `[start, end)`.
 */
export function codeRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  const inline = (from: number, to: number) => {
    for (const span of text.slice(from, to).matchAll(INLINE_CODE)) {
      ranges.push([from + span.index, from + span.index + span[0].length]);
    }
  };
  for (const fence of text.matchAll(FENCE)) {
    inline(cursor, fence.index);
    ranges.push([fence.index, fence.index + fence[0].length]);
    cursor = fence.index + fence[0].length;
  }
  inline(cursor, text.length);
  return ranges;
}
