// SPDX-License-Identifier: AGPL-3.0-or-later

// Edits a TOML file that another program writes too: Codex keeps trusted
// projects and its own settings in the `config.toml` J3 Bots provisions. A
// writer owns some top-level keys and some tables, and replaces only those,
// where they are; every other line stays as it is. Ownership goes by key and
// table path, not by comment markers, so a file the other program rewrote and
// reordered is still edited correctly. The approach follows the operator's
// own `t3-setup` sync.

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
  /** Whether an existing table is this writer's. Its tables are replaced by `tables`. */
  readonly owns: (path: ReadonlyArray<string>) => boolean;
  /** The tables this writer wants, in order, where its first table was, or at the end. */
  readonly tables: ReadonlyArray<TomlTable>;
}

/**
 * A TOML basic string. JSON's escapes are TOML's, except that TOML takes
 * neither a raw DEL nor an escaped lone surrogate, so the text is made well
 * formed first and DEL is escaped.
 */
export const tomlString = (value: string) =>
  JSON.stringify(value.toWellFormed()).replaceAll("\u007f", "\\u007f");

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const HEADER = /^\s*(\[\[?)([^\]\r\n]+)\]\]?\s*(?:#.*)?$/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;

const keyText = (key: string) => (BARE_KEY.test(key) ? key : tomlString(key));

const valueText = (value: TomlValue): string =>
  typeof value === "string" ? tomlString(value) : `[${value.map(tomlString).join(", ")}]`;

const render = (table: TomlTable) =>
  [
    `[${table.path.map(keyText).join(".")}]`,
    ...table.values.map(([key, value]) => `${keyText(key)} = ${valueText(value)}`),
  ].join("\n");

/** A table header's keys, quotes honoured: `model."gpt-5.5"` is two keys. */
const headerKeys = (text: string): ReadonlyArray<string> => {
  const keys: Array<string> = [];
  const segment = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/y;
  let match = segment.exec(text);
  while (match !== null) {
    const raw = match[1] ?? "";
    if (raw.startsWith('"')) {
      const parsed: unknown = JSON.parse(raw);
      keys.push(typeof parsed === "string" ? parsed : raw);
    } else {
      keys.push(raw.startsWith("'") ? raw.slice(1, -1) : raw);
    }
    if (segment.lastIndex >= text.length) break;
    match = segment.exec(text);
  }
  return keys;
};

interface Chunk {
  readonly path: ReadonlyArray<string>;
  readonly arrayTable: boolean;
  readonly lines: Array<string>;
}

/**
 * The lines before the first table, and one chunk per table. A table keeps
 * the comments right above its header, so replacing it leaves none behind.
 */
const split = (text: string) => {
  const preamble: Array<string> = [];
  const tables: Array<Chunk> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = HEADER.exec(line);
    const current = tables.at(-1)?.lines ?? preamble;
    if (match === null) {
      current.push(line);
      continue;
    }
    const leading: Array<string> = [];
    while (current.length > 0 && COMMENT_OR_BLANK.test(current.at(-1) ?? "")) {
      leading.unshift(current.pop() ?? "");
    }
    tables.push({
      path: headerKeys(match[2] ?? ""),
      arrayTable: match[1] === "[[",
      lines: [...leading, line],
    });
  }
  return { preamble, tables };
};

/**
 * How many lines the assignment at `lines[start]` takes: more than one only
 * for a multi-line string, which runs to its closing delimiter.
 */
const assignmentLength = (lines: ReadonlyArray<string>, start: number) => {
  const value = (lines[start] ?? "").replace(/^[^=]*=\s*/, "");
  const delimiter = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
  if (delimiter === null || value.indexOf(delimiter, 3) !== -1) return 1;
  for (let end = start + 1; end < lines.length; end++) {
    if ((lines[end] ?? "").includes(delimiter)) return end - start + 1;
  }
  return lines.length - start;
};

/** Each owned top-level key set where it is, or after the others, or removed. */
const setKeys = (preamble: ReadonlyArray<string>, keys: TomlEdit["keys"]) => {
  const lines = [...preamble];
  for (const [key, value] of keys) {
    const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = new RegExp(`^\\s*(?:${name}|"${name}")\\s*=`);
    const index = lines.findIndex((line) => assignment.test(line));
    const replacement = value === undefined ? [] : [`${keyText(key)} = ${valueText(value)}`];
    if (index >= 0) lines.splice(index, assignmentLength(lines, index), ...replacement);
    else lines.push(...replacement);
  }
  return lines;
};

export const editToml = (text: string, edit: TomlEdit): string => {
  const { preamble, tables } = split(text);
  const owned = (table: Chunk) => !table.arrayTable && edit.owns(table.path);
  const ours = edit.tables.map(render);
  const parts = [setKeys(preamble, edit.keys).join("\n").trim()];
  let placed = false;
  for (const table of tables) {
    if (!owned(table)) parts.push(table.lines.join("\n").trim());
    else if (!placed) {
      parts.push(...ours);
      placed = true;
    }
  }
  if (!placed) parts.push(...ours);
  const body = parts.filter((part) => part !== "").join("\n\n");
  return body === "" ? "" : `${body}\n`;
};
