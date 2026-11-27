// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { Block, DocumentContent, Run } from "./model.ts";
import { addRun, plainText } from "./office.ts";

/**
 * A Markdown file as a flow of blocks: headings, paragraphs in bold, italic
 * and code, lists and task lists, quotes, code blocks, tables and rules. What
 * Markdown writes as HTML shows as the text it is. A link is its text and an
 * image its description: nothing the file names is fetched or opened.
 */
export function readMarkdown(text: string, cut: boolean): DocumentContent {
  const reader = new MarkdownReader(
    text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"),
  );
  reader.read();
  return { _tag: "flow", blocks: reader.blocks, pages: null, cut: cut || reader.cut };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const DIVIDER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const INDENTED = /^( {4}|\t)/;

const BULLETS = ["•", "◦", "▪"] as const;

const widthOf = (indent: string) => indent.replaceAll("\t", "    ").length;

class MarkdownReader {
  readonly blocks: Array<Block> = [];
  cut = false;
  #at = 0;
  readonly #lines: ReadonlyArray<string>;

  constructor(lines: ReadonlyArray<string>) {
    this.#lines = lines;
  }

  push(block: Block) {
    if (this.blocks.length >= DOCUMENT_LIMITS.blocks) this.cut = true;
    else this.blocks.push(block);
  }

  /** Whether `line` starts a block of its own, which ends a paragraph or a list item's lines. */
  starts(line: string, next: string | undefined): boolean {
    return (
      FENCE.test(line) ||
      HEADING.test(line) ||
      RULE.test(line) ||
      QUOTE.test(line) ||
      ITEM.test(line) ||
      (line.includes("|") && next !== undefined && DIVIDER.test(next))
    );
  }

  read() {
    const lines = this.#lines;
    while (this.#at < lines.length && !this.cut) {
      const line = lines[this.#at] ?? "";
      const next = lines[this.#at + 1];
      if (line.trim() === "") {
        this.#at++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence !== null) {
        this.code(fence[1] ?? "```");
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading !== null) {
        this.push({
          _tag: "heading",
          level: heading[1]?.length ?? 1,
          runs: inline(heading[2] ?? ""),
        });
        this.#at++;
        continue;
      }
      if (RULE.test(line)) {
        this.push({ _tag: "rule" });
        this.#at++;
        continue;
      }
      if (QUOTE.test(line)) {
        this.quote();
        continue;
      }
      if (ITEM.test(line)) {
        this.item();
        continue;
      }
      if (line.includes("|") && next !== undefined && DIVIDER.test(next)) {
        this.table();
        continue;
      }
      if (INDENTED.test(line)) {
        this.indented();
        continue;
      }
      this.paragraph();
    }
  }

  code(opening: string) {
    const lines = this.#lines;
    const body: Array<string> = [];
    this.#at++;
    while (this.#at < lines.length) {
      const line = lines[this.#at] ?? "";
      this.#at++;
      const trimmed = line.trim();
      if (
        trimmed.startsWith(opening[0] ?? "`") &&
        /^(`+|~+)$/.test(trimmed) &&
        trimmed.length >= opening.length
      ) {
        break;
      }
      body.push(line);
    }
    this.push({ _tag: "code", text: body.join("\n") });
  }

  indented() {
    const lines = this.#lines;
    const body: Array<string> = [];
    while (this.#at < lines.length) {
      const line = lines[this.#at] ?? "";
      if (line.trim() !== "" && !INDENTED.test(line)) break;
      body.push(line.replace(INDENTED, ""));
      this.#at++;
    }
    while (body.at(-1)?.trim() === "") body.pop();
    this.push({ _tag: "code", text: body.join("\n") });
  }

  quote() {
    const lines = this.#lines;
    const inside: Array<string> = [];
    while (this.#at < lines.length) {
      const match = QUOTE.exec(lines[this.#at] ?? "");
      if (match === null) break;
      inside.push(match[1] ?? "");
      this.#at++;
    }
    // Each paragraph of the quote is a quote block.
    for (const paragraph of inside.join("\n").split(/\n[ \t]*\n/)) {
      if (paragraph.trim() !== "") this.push({ _tag: "quote", runs: inline(paragraph) });
    }
  }

  item() {
    const lines = this.#lines;
    const match = ITEM.exec(lines[this.#at] ?? "");
    if (match === null) return;
    const [, indent = "", written = "", first = ""] = match;
    const depth = Math.min(Math.floor(widthOf(indent) / 2), 8);
    const ordered = /\d/.test(written);
    const task = TASK.exec(first);
    const marker =
      task !== null
        ? task[1] === " "
          ? "☐"
          : "☑"
        : ordered
          ? written
          : (BULLETS[depth % 3] ?? "•");
    const text = [task === null ? first : (task[2] ?? "")];
    this.#at++;
    // Its lazy continuation: lines that start no block of their own.
    while (this.#at < lines.length) {
      const line = lines[this.#at] ?? "";
      if (line.trim() === "" || this.starts(line, lines[this.#at + 1])) break;
      text.push(line.trim());
      this.#at++;
    }
    this.push({ _tag: "item", depth, marker, runs: inline(text.join("\n")) });
  }

  table() {
    const lines = this.#lines;
    const rows = [cells(lines[this.#at] ?? "")];
    this.#at += 2;
    while (this.#at < lines.length) {
      const line = lines[this.#at] ?? "";
      if (line.trim() === "" || !line.includes("|")) break;
      if (rows.length < DOCUMENT_LIMITS.rows) rows.push(cells(line));
      else this.cut = true;
      this.#at++;
    }
    const width = Math.min(Math.max(...rows.map((row) => row.length)), DOCUMENT_LIMITS.columns);
    this.push({
      _tag: "table",
      header: true,
      rows: rows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? "")),
    });
  }

  paragraph() {
    const lines = this.#lines;
    const text: Array<string> = [];
    while (this.#at < lines.length) {
      const line = lines[this.#at] ?? "";
      if (line.trim() === "") break;
      // An underline of = or - makes the paragraph above it a heading, before it reads as a rule.
      const setext = text.length > 0 ? SETEXT.exec(line) : null;
      if (setext !== null) {
        this.#at++;
        this.push({
          _tag: "heading",
          level: setext[1]?.startsWith("=") ? 1 : 2,
          runs: inline(text.join("\n")),
        });
        return;
      }
      if (text.length > 0 && this.starts(line, lines[this.#at + 1])) break;
      text.push(line);
      this.#at++;
    }
    this.push({ _tag: "paragraph", runs: inline(text.join("\n")) });
  }
}

/** A table row's cells, split at the bars that are not escaped, as plain text. */
function cells(line: string): Array<string> {
  const trimmed = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => plainText(inline(cell.trim().replaceAll("\\|", "|"))));
}

type Style = Omit<Run, "text">;

const PLAIN: Style = { bold: false, italic: false, code: false };

/**
 * The runs of a paragraph's text: `**bold**`, `*italic*`, `` `code` ``, a
 * link as its text, an image as its description, backslash escapes, and a
 * line break where the line ends in two spaces or a backslash; any other line
 * end is a space.
 */
function inline(text: string): Array<Run> {
  const runs: Array<Run> = [];
  const joined = text
    .replaceAll(/(?: {2,}|\\)\n/g, " ")
    .replaceAll(/[ \t]*\n[ \t]*/g, " ")
    .replaceAll(" ", "\n");
  spans(joined.trim(), PLAIN, runs);
  return runs;
}

// What follows a link's text: its address in parentheses, perhaps in angle
// brackets, and perhaps a title. Matched where the text's `]` is.
const LINK_TARGET = /\(\s*<?[^\s)>]*>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
// An address in angle brackets; it cannot hold another `<`, so each `<` scans only up to the next.
const AUTOLINK = /<((?:https?|mailto):[^\s<>]+)>/iy;

/** Whether `char` is a letter or a digit, which an underscore inside a word does not emphasize. */
const wordy = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Whether `char` is one a backslash escapes. */
const escapable = (char: string | undefined) => char !== undefined && /[!-/:-@[-`{-~]/.test(char);

/**
 * What a text's spans are found with, worked out once per text so that
 * reading it takes time in proportion to its length, whatever it holds: a
 * file of a thousand `[` or `*` with nothing to close them costs no more than
 * any other.
 */
class Closers {
  /** For each position, the next `]` not escaped at or after it; the text's length if none. */
  private readonly brackets: Int32Array;
  /** Where each marker can close emphasis, in order. */
  private readonly emphasis = new Map<string, ReadonlyArray<number>>();
  /** The end of a link's target after the `]` at a position, or -1 when none follows. */
  private readonly targets = new Map<number, number>();
  /** For each run of backticks, the first position from which it has no closing run. */
  private readonly unclosedTicks = new Map<string, number>();

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    const { length } = text;
    const escaped = new Uint8Array(length);
    for (let at = 1; at < length; at++) {
      escaped[at] = text[at - 1] === "\\" && escaped[at - 1] === 0 && escapable(text[at]) ? 1 : 0;
    }
    this.brackets = new Int32Array(length + 1);
    this.brackets[length] = length;
    for (let at = length - 1; at >= 0; at--) {
      this.brackets[at] =
        text[at] === "]" && escaped[at] === 0 ? at : (this.brackets[at + 1] ?? length);
    }
  }

  /** The text of a link whose `[` is at `open`, and where the link ends; null when it is no link. */
  link(open: number): { readonly text: string; readonly end: number } | null {
    const close = this.brackets[open + 1] ?? this.text.length;
    if (close >= this.text.length) return null;
    let end = this.targets.get(close);
    if (end === undefined) {
      LINK_TARGET.lastIndex = close + 1;
      end = LINK_TARGET.test(this.text) ? LINK_TARGET.lastIndex : -1;
      this.targets.set(close, end);
    }
    return end < 0 ? null : { text: this.text.slice(open + 1, close), end };
  }

  /** Where the code span opened by `ticks` at `from` closes, or -1. */
  code(ticks: string, from: number): number {
    if (from >= (this.unclosedTicks.get(ticks) ?? Number.POSITIVE_INFINITY)) return -1;
    const end = this.text.indexOf(ticks, from);
    if (end < 0) this.unclosedTicks.set(ticks, from);
    return end;
  }

  /**
   * Where emphasis opened with `marker`, whose text starts at `from`, closes:
   * after text, not after a space or a backslash, nor before a letter for
   * `_`; a single marker never closes inside a run of them.
   */
  closing(marker: string, from: number): number {
    let places = this.emphasis.get(marker);
    if (places === undefined) {
      const found: Array<number> = [];
      for (let at = this.text.indexOf(marker, 1); at > 0; at = this.text.indexOf(marker, at + 1)) {
        const before = this.text[at - 1];
        const after = this.text[at + marker.length];
        if (marker.length === 1 && (after === marker || before === marker)) continue;
        if (before !== undefined && /\s/.test(before)) continue;
        if (before === "\\") continue;
        if (marker[0] === "_" && wordy(after)) continue;
        found.push(at);
      }
      places = found;
      this.emphasis.set(marker, places);
    }
    // The first place after at least one character of text.
    let low = 0;
    let high = places.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((places[middle] ?? 0) > from) high = middle;
      else low = middle + 1;
    }
    return places[low] ?? -1;
  }
}

function spans(text: string, style: Style, runs: Array<Run>): void {
  const closers = new Closers(text);
  let plain = "";
  const flush = () => {
    addRun(runs, plain, style);
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === "\\" && escapable(text[at + 1])) {
      plain += text[at + 1];
      at += 2;
      continue;
    }
    if (char === "`") {
      let count = 1;
      while (text[at + count] === "`") count++;
      const ticks = "`".repeat(count);
      const end = closers.code(ticks, at + count);
      if (end > 0) {
        flush();
        addRun(runs, text.slice(at + count, end).trim(), { ...style, code: true });
        at = end + count;
        continue;
      }
      // An unclosed run of backticks is text, all of it.
      plain += ticks;
      at += count;
      continue;
    }
    if (char === "[" || (char === "!" && text[at + 1] === "[")) {
      const link = closers.link(char === "!" ? at + 1 : at);
      if (link !== null) {
        flush();
        spans(link.text, style, runs);
        at = link.end;
        continue;
      }
    }
    if (char === "<") {
      AUTOLINK.lastIndex = at;
      const link = AUTOLINK.exec(text);
      if (link !== null) {
        plain += link[1];
        at = AUTOLINK.lastIndex;
        continue;
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      const double = text[at + 1] === char;
      const marker = double ? char + char : char;
      const opens =
        text[at + marker.length] !== undefined &&
        !/\s/.test(text[at + marker.length] ?? "") &&
        !(char === "_" && wordy(text[at - 1])) &&
        (char !== "~" || double);
      const end = opens ? closers.closing(marker, at + marker.length) : -1;
      if (end > 0) {
        flush();
        const inner = text.slice(at + marker.length, end);
        spans(
          inner,
          char === "~" ? style : double ? { ...style, bold: true } : { ...style, italic: true },
          runs,
        );
        at = end + marker.length;
        continue;
      }
    }
    plain += char;
    at++;
  }
  flush();
}
