// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  parse,
  TomlError,
  type TomlTableWithoutBigInt,
  type TomlValueWithoutBigInt,
} from "smol-toml";

// Edits a TOML file that another program writes too: Codex keeps trusted
// projects and its own settings in the `config.toml` J3 Bots provisions. A
// writer owns some top-level keys and some tables, and replaces only those,
// where they are; every other statement stays as it is written. Ownership
// goes by key and table path, not by comment markers, so a file the other
// program rewrote and reordered is still edited correctly. The approach
// follows the operator's own `t3-setup` sync.
//
// The file is read statement by statement, with TOML's strings (basic,
// literal, multi-line), arrays and inline tables read whole, so nothing inside
// a value or a quoted key is taken for a table header. A file that is not
// TOML, or that this reading does not follow, is left as it is: TOML's own
// parser checks the file before the edit, and checks after it that everything
// the writer does not own reads the same.

/** A value J3 Bots writes: a string, or a list of strings. */
type TomlValue = string | ReadonlyArray<string>;

/** A table to write: its path (`["mcp_servers", "j3"]` is `[mcp_servers.j3]`) and its keys, in order. */
export interface TomlTable {
  readonly path: ReadonlyArray<string>;
  readonly values: ReadonlyArray<readonly [string, TomlValue]>;
}

export interface TomlEdit {
  /** Top-level keys this writer owns: set to the value, or removed when it is undefined. */
  readonly keys: ReadonlyArray<readonly [string, TomlValue | undefined]>;
  /**
   * The tables this writer owns, with everything under them, however the
   * file writes them: a table, a sub-table, a dotted key or an inline table.
   * They are replaced by `tables`.
   */
  readonly owns: ReadonlyArray<ReadonlyArray<string>>;
  /** The tables this writer wants, in order, where its first table was, or at the end. */
  readonly tables: ReadonlyArray<TomlTable>;
}

/** The edited text, or why the file was left as it is. */
export type TomlEdited =
  | { readonly _tag: "edited"; readonly text: string }
  /** `reason` names a place in the file, never its contents. */
  | { readonly _tag: "unreadable"; readonly reason: string };

/**
 * A TOML basic string. JSON's escapes are TOML's, except that TOML takes
 * neither a raw DEL nor an escaped lone surrogate, so the text is made well
 * formed first and DEL is escaped.
 */
export const tomlString = (value: string) =>
  JSON.stringify(value.toWellFormed()).replaceAll("\u007f", "\\u007f");

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const keyText = (key: string) => (BARE_KEY.test(key) ? key : tomlString(key));

const valueText = (value: TomlValue): string =>
  typeof value === "string" ? tomlString(value) : `[${value.map(tomlString).join(", ")}]`;

const pathText = (path: ReadonlyArray<string>) => path.map(keyText).join(".");

const render = (table: TomlTable) =>
  [
    `[${pathText(table.path)}]`,
    ...table.values.map(([key, value]) => `${keyText(key)} = ${valueText(value)}`),
  ].join("\n");

/** A table as a pair inside an inline table, its path relative to that table's. */
const renderInline = (table: TomlTable, under: ReadonlyArray<string>) =>
  `${pathText(table.path.slice(under.length))} = { ${table.values
    .map(([key, value]) => `${keyText(key)} = ${valueText(value)}`)
    .join(", ")} }`;

// ---------------------------------------------------------------------------
// Reading statements

/** One pair of an inline table: its key, and its text from the key to the end of its value. */
interface InlinePair {
  readonly key: ReadonlyArray<string>;
  readonly text: string;
}

/** A pair whose value is an inline table: the text around the braces, and its pairs. */
interface InlineTable {
  /** From the statement's start to the opening brace. */
  readonly before: string;
  readonly pairs: ReadonlyArray<InlinePair>;
  /** From after the closing brace to the statement's end, a comment included. */
  readonly after: string;
}

/** One statement, with its text up to its line break, and the line it starts on. */
type Statement =
  /** A blank line, or one that holds only a comment. */
  | { readonly _tag: "trivia"; readonly text: string }
  | {
      readonly _tag: "header";
      readonly path: ReadonlyArray<string>;
      readonly arrayTable: boolean;
      readonly text: string;
      readonly line: number;
    }
  | {
      readonly _tag: "pair";
      readonly key: ReadonlyArray<string>;
      readonly text: string;
      readonly line: number;
      readonly inline: InlineTable | null;
    };

/** A place in the file this reading does not follow. */
class Unfollowed {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};
const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
const SCALAR_END = /[\s,\]}#]/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a TOML text into statements. Throws `Unfollowed`, and only that. */
class Reader {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private get done() {
    return this.pos >= this.text.length;
  }

  private peek(offset = 0) {
    return this.text[this.pos + offset] ?? "";
  }

  private at(token: string) {
    return this.text.startsWith(token, this.pos);
  }

  private get line() {
    return this.text.slice(0, this.pos).split("\n").length;
  }

  private fail(what: string): never {
    throw new Unfollowed(`${what} on line ${this.line}`);
  }

  private spaces() {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private comment() {
    if (this.peek() !== "#") return;
    while (!this.done && this.peek() !== "\n" && !this.at("\r\n")) this.pos++;
  }

  private lineBreak() {
    if (this.peek() === "\n") {
      this.pos += 1;
      return true;
    }
    if (this.at("\r\n")) {
      this.pos += 2;
      return true;
    }
    return false;
  }

  /** Spaces and a comment to the line's end: where the statement's text ends. */
  private restOfLine() {
    this.spaces();
    this.comment();
    const end = this.pos;
    if (!this.done && !this.lineBreak()) this.fail("Unexpected text after a statement");
    return end;
  }

  /** Spaces, comments and line breaks, as may come between an array's values. */
  private gap() {
    for (;;) {
      this.spaces();
      this.comment();
      if (!this.lineBreak()) return;
    }
  }

  private key(): Array<string> {
    const parts: Array<string> = [];
    for (;;) {
      this.spaces();
      parts.push(this.keyPart());
      this.spaces();
      if (this.peek() !== ".") return parts;
      this.pos++;
    }
  }

  private keyPart(): string {
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    const start = this.pos;
    while (/[A-Za-z0-9_-]/.test(this.peek())) this.pos++;
    if (this.pos === start) this.fail("A key was expected");
    return this.text.slice(start, this.pos);
  }

  private escape(): string {
    const letter = this.peek();
    this.pos++;
    const simple = ESCAPES[letter];
    if (simple !== undefined) return simple;
    const digits = HEX_DIGITS[letter];
    if (digits === undefined) this.fail("An unknown escape");
    const hex = this.text.slice(this.pos, this.pos + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) this.fail("A malformed escape");
    this.pos += digits;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail("An escape out of range");
    return String.fromCodePoint(code);
  }

  /** A single-line basic string, decoded. */
  private basicString(): string {
    this.pos++;
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === "" || char === "\n" || char === "\r") this.fail("A string that is not closed");
      this.pos++;
      if (char === '"') return value;
      value += char === "\\" ? this.escape() : char;
    }
  }

  /** A single-line literal string. */
  private literalString(): string {
    const start = this.pos + 1;
    const end = this.text.indexOf("'", start);
    const lineEnd = this.text.indexOf("\n", start);
    if (end === -1 || (lineEnd !== -1 && lineEnd < end)) this.fail("A string that is not closed");
    this.pos = end + 1;
    return this.text.slice(start, end);
  }

  /** A multi-line string: to its closing delimiter, which up to two more quotes may follow. */
  private multiLineString(delimiter: '"""' | "'''") {
    this.pos += 3;
    for (;;) {
      if (this.done) this.fail("A multi-line string that is not closed");
      if (delimiter === '"""' && this.peek() === "\\") {
        this.pos += 2;
        continue;
      }
      if (this.at(delimiter)) {
        this.pos += 3;
        for (let extra = 0; extra < 2 && this.peek() === delimiter[0]; extra++) this.pos++;
        return;
      }
      this.pos++;
    }
  }

  private value() {
    if (this.at('"""')) return this.multiLineString('"""');
    if (this.at("'''")) return this.multiLineString("'''");
    if (this.peek() === '"') return void this.basicString();
    if (this.peek() === "'") return void this.literalString();
    if (this.peek() === "[") return this.sequence("]", () => this.value());
    if (this.peek() === "{") return void this.inlineTable();
    const start = this.pos;
    while (!this.done && !SCALAR_END.test(this.peek())) {
      this.pos++;
      // A date and a time may be apart by a space.
      if (
        LOCAL_DATE.test(this.text.slice(start, this.pos)) &&
        this.peek() === " " &&
        /\d/.test(this.peek(1))
      ) {
        this.pos++;
      }
    }
    if (this.pos === start) this.fail("A value was expected");
  }

  /** An inline table's pairs, each with its text. */
  private inlineTable(): ReadonlyArray<InlinePair> {
    const pairs: Array<InlinePair> = [];
    this.sequence("}", () => {
      const from = this.pos;
      const key = this.key();
      if (this.peek() !== "=") this.fail("= was expected");
      this.pos++;
      this.spaces();
      this.value();
      pairs.push({ key, text: this.text.slice(from, this.pos).trim() });
    });
    return pairs;
  }

  /** An array's values or an inline table's pairs, to `close`, line breaks and a last comma allowed. */
  private sequence(close: "]" | "}", item: () => void) {
    this.pos++;
    for (;;) {
      this.gap();
      if (this.peek() === close) {
        this.pos++;
        return;
      }
      item();
      this.gap();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      this.gap();
      if (this.peek() !== close)
        this.fail(
          close === "]" ? "An array that is not closed" : "An inline table that is not closed",
        );
      this.pos++;
      return;
    }
  }

  statements(): ReadonlyArray<Statement> {
    const statements: Array<Statement> = [];
    while (!this.done) {
      const start = this.pos;
      this.spaces();
      if (this.done || this.peek() === "#" || this.peek() === "\n" || this.at("\r\n")) {
        const end = this.restOfLine();
        statements.push({ _tag: "trivia", text: this.text.slice(start, end) });
        continue;
      }
      const line = this.line;
      if (this.peek() === "[") {
        const arrayTable = this.at("[[");
        this.pos += arrayTable ? 2 : 1;
        const path = this.key();
        const close = arrayTable ? "]]" : "]";
        if (!this.at(close)) this.fail("A table header that is not closed");
        this.pos += close.length;
        const end = this.restOfLine();
        statements.push({
          _tag: "header",
          path,
          arrayTable,
          text: this.text.slice(start, end),
          line,
        });
        continue;
      }
      const key = this.key();
      if (this.peek() !== "=") this.fail("= was expected");
      this.pos++;
      this.spaces();
      const open = this.pos;
      const pairs = this.peek() === "{" ? this.inlineTable() : null;
      if (pairs === null) this.value();
      const close = this.pos;
      const end = this.restOfLine();
      statements.push({
        _tag: "pair",
        key,
        text: this.text.slice(start, end),
        line,
        inline:
          pairs === null
            ? null
            : {
                before: this.text.slice(start, open),
                pairs,
                after: this.text.slice(close, end),
              },
      });
    }
    return statements;
  }
}

// ---------------------------------------------------------------------------
// Checking with TOML's parser

/** The text as TOML's parser reads it, or why it does not. */
const parsed = (
  text: string,
):
  | { readonly _tag: "ok"; readonly table: TomlTableWithoutBigInt }
  | { readonly _tag: "error"; readonly at: string } => {
  try {
    return { _tag: "ok", table: parse(text, { integersAsBigInt: false }) };
  } catch (error) {
    if (error instanceof TomlError) {
      return { _tag: "error", at: `line ${error.line}, column ${error.column}` };
    }
    throw error;
  }
};

const isTable = (value: TomlValueWithoutBigInt): value is TomlTableWithoutBigInt => {
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The table without what the writer owns, and without empty tables, which hold
 * nothing: a parent table an owned one leaves empty reads the same as none.
 */
const unowned = (
  table: TomlTableWithoutBigInt,
  edit: TomlEdit,
  path: ReadonlyArray<string> = [],
): TomlTableWithoutBigInt => {
  const kept: TomlTableWithoutBigInt = {};
  for (const [key, value] of Object.entries(table)) {
    const at = [...path, key];
    if (path.length === 0 && edit.keys.some(([owned]) => owned === key)) continue;
    if (edit.owns.some((owned) => sameStart(owned, at))) continue;
    const rest = isTable(value) ? unowned(value, edit, at) : value;
    if (isTable(rest) && Object.keys(rest).length === 0) continue;
    kept[key] = rest;
  }
  return kept;
};

/**
 * The first path at which `a` and `b` read differently, or null when they
 * read the same. Only key names make up a path, never values.
 */
const difference = (
  a: TomlValueWithoutBigInt,
  b: TomlValueWithoutBigInt,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<string> | null => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return path;
    for (const [index, item] of a.entries()) {
      const other = b[index];
      if (other === undefined) return path;
      if (difference(item, other, path) !== null) return path;
    }
    return null;
  }
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) return path;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const left = a[key];
      const right = b[key];
      if (left === undefined || right === undefined) return [...path, key];
      const found = difference(left, right, [...path, key]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof a === "object" || typeof b === "object") {
    return typeof a === typeof b && String(a) === String(b) ? null : path;
  }
  return Object.is(a, b) ? null : path;
};

/** Whether `path` starts with `prefix`. */
const sameStart = (prefix: ReadonlyArray<string>, path: ReadonlyArray<string>) =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

// ---------------------------------------------------------------------------
// Editing

interface Chunk {
  /** Null for the statements before the first table. */
  readonly header: (Statement & { readonly _tag: "header" }) | null;
  /** The comments and blank lines right above the header. */
  readonly leading: ReadonlyArray<Statement>;
  readonly statements: Array<Statement>;
}

/**
 * The statements before the first table, and one chunk per table. A table
 * keeps the comments and blank lines right above its header apart, so they
 * stay where they are when the table is replaced.
 */
const chunks = (statements: ReadonlyArray<Statement>) => {
  const all: Array<Chunk> = [{ header: null, leading: [], statements: [] }];
  for (const statement of statements) {
    const current = all.at(-1) ?? { header: null, leading: [], statements: [] };
    if (statement._tag !== "header") {
      current.statements.push(statement);
      continue;
    }
    const leading: Array<Statement> = [];
    while (current.statements.at(-1)?._tag === "trivia") {
      const last = current.statements.pop();
      if (last !== undefined) leading.unshift(last);
    }
    all.push({ header: statement, leading, statements: [statement] });
  }
  return all;
};

const textOf = (statements: ReadonlyArray<Statement>) =>
  statements
    .map((statement) => statement.text)
    .join("\n")
    .trim();

export const editToml = (text: string, edit: TomlEdit): TomlEdited => {
  const before = parsed(text);
  if (before._tag === "error") {
    return { _tag: "unreadable", reason: `it is not valid TOML (${before.at})` };
  }
  let statements: ReadonlyArray<Statement>;
  try {
    statements = new Reader(text).statements();
  } catch (error) {
    if (error instanceof Unfollowed) return { _tag: "unreadable", reason: error.reason };
    throw error;
  }
  const owned = (path: ReadonlyArray<string>) =>
    edit.owns.some((prefix) => sameStart(prefix, path));
  /** The owned tables a pair at `path` holds part of: its path is a strict prefix of theirs. */
  const ownedWithin = (path: ReadonlyArray<string>) =>
    edit.owns.filter((prefix) => prefix.length > path.length && sameStart(path, prefix));

  /** Tables written inside an inline table, rather than as tables of their own. */
  const inlined = new Set<TomlTable>();
  /**
   * A pair at `path` whose value holds part of an owned table: its inline
   * table with the owned pairs replaced by J3 Bots' tables, and every other
   * pair as it was written. Anything else cannot take a table, and is refused
   * with its line.
   */
  const editInline = (
    statement: Statement & { readonly _tag: "pair" },
    path: ReadonlyArray<string>,
    within: ReadonlyArray<ReadonlyArray<string>>,
  ): Statement | Unfollowed => {
    const at = `${pathText(path)} on line ${statement.line}`;
    if (statement.inline === null) {
      return new Unfollowed(`${at} is not a table, and J3 Bots' tables go under it`);
    }
    const relative = within.map((prefix) => prefix.slice(path.length));
    const kept: Array<string> = [];
    for (const pair of statement.inline.pairs) {
      if (relative.some((prefix) => sameStart(prefix, pair.key))) continue;
      if (
        relative.some((prefix) => prefix.length > pair.key.length && sameStart(pair.key, prefix))
      ) {
        return new Unfollowed(`${at} holds J3 Bots' tables deeper than it can edit`);
      }
      kept.push(pair.text);
    }
    const ours = edit.tables.filter((table) =>
      within.some((prefix) => sameStart(prefix, table.path)),
    );
    for (const table of ours) inlined.add(table);
    const pairs = [...kept, ...ours.map((table) => renderInline(table, path))];
    const body = pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
    return {
      ...statement,
      text: `${statement.inline.before}${body}${statement.inline.after}`,
    };
  };

  /** A pair as it is written after the edit: kept, edited inside, or removed when owned. */
  const pairAfter = (
    statement: Statement & { readonly _tag: "pair" },
    path: ReadonlyArray<string>,
  ): Statement | Unfollowed | null => {
    if (owned(path)) return null;
    const within = ownedWithin(path);
    return within.length === 0 ? statement : editInline(statement, path, within);
  };

  const [preamble, ...tables] = chunks(statements);
  // Each owned top-level key set where it is, or after the others, or removed.
  const top: Array<Statement> = [];
  const placed = new Set<string>();
  for (const statement of preamble?.statements ?? []) {
    if (statement._tag !== "pair") {
      top.push(statement);
      continue;
    }
    const [name, ...rest] = statement.key;
    const ownedKey = rest.length === 0 ? edit.keys.find(([key]) => key === name) : undefined;
    if (ownedKey !== undefined) {
      const [key, value] = ownedKey;
      if (!placed.has(key) && value !== undefined) {
        top.push({
          _tag: "pair",
          key: [key],
          text: `${keyText(key)} = ${valueText(value)}`,
          line: statement.line,
          inline: null,
        });
      }
      placed.add(key);
      continue;
    }
    const after = pairAfter(statement, statement.key);
    if (after instanceof Unfollowed) return { _tag: "unreadable", reason: after.reason };
    if (after !== null) top.push(after);
  }
  for (const [key, value] of edit.keys) {
    if (!placed.has(key) && value !== undefined) {
      top.push({
        _tag: "pair",
        key: [key],
        text: `${keyText(key)} = ${valueText(value)}`,
        line: 0,
        inline: null,
      });
    }
  }

  const kept: Array<{ readonly owned: boolean; readonly leading: string; readonly text: string }> =
    [];
  for (const table of tables) {
    const path = table.header?.path ?? [];
    const leading = textOf(table.leading);
    if (owned(path)) {
      kept.push({ owned: true, leading, text: "" });
      continue;
    }
    const body: Array<Statement> = [...table.leading];
    for (const statement of table.statements) {
      if (statement._tag !== "pair") {
        body.push(statement);
        continue;
      }
      const after = pairAfter(statement, [...path, ...statement.key]);
      if (after instanceof Unfollowed) return { _tag: "unreadable", reason: after.reason };
      if (after !== null) body.push(after);
    }
    kept.push({ owned: false, leading, text: textOf(body) });
  }

  // J3 Bots' tables go where its first table was, under the comments above
  // it, or at the end. The comments above another table it owned stay where
  // they were.
  const ours = edit.tables.filter((table) => !inlined.has(table)).map(render);
  const parts = [textOf(top)];
  let oursPlaced = false;
  for (const table of kept) {
    if (!table.owned) {
      parts.push(table.text);
      continue;
    }
    if (oursPlaced) {
      parts.push(table.leading);
      continue;
    }
    const [first, ...rest] = ours;
    parts.push([table.leading, first ?? ""].filter((part) => part !== "").join("\n"), ...rest);
    oursPlaced = true;
  }
  if (!oursPlaced) parts.push(...ours);
  const body = parts.filter((part) => part !== "").join("\n\n");
  const edited = body === "" ? "" : `${body}\n`;

  // What the writer does not own reads the same after the edit.
  const after = parsed(edited);
  if (after._tag === "error") {
    const conflict = statements.find(
      (statement): statement is Statement & { readonly _tag: "pair" | "header" } =>
        statement._tag !== "trivia" &&
        edit.owns.some(
          (prefix) =>
            prefix[0] === (statement._tag === "header" ? statement.path : statement.key)[0],
        ),
    );
    return {
      _tag: "unreadable",
      reason:
        conflict === undefined
          ? "J3 Bots' tables cannot be added to it"
          : `J3 Bots' tables cannot be added next to how line ${conflict.line} writes them`,
    };
  }
  const changed = difference(unowned(before.table, edit), unowned(after.table, edit));
  if (changed !== null) {
    return {
      _tag: "unreadable",
      reason: `an edit would change ${changed.length === 0 ? "the file" : pathText(changed)}, which J3 Bots does not own`,
    };
  }
  return { _tag: "edited", text: edited };
};
