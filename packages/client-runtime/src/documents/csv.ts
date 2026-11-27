// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { DocumentContent } from "./model.ts";
import { clip } from "./office.ts";

const DELIMITERS = [",", ";", "\t", "|"] as const;
type Delimiter = (typeof DELIMITERS)[number];

/**
 * The delimiter a CSV file uses: what its `sep=` line names, as spreadsheets
 * write it, or the one its first lines use most evenly outside quotes. A
 * spreadsheet in a language whose decimal mark is a comma, as Portuguese, saves
 * CSV with semicolons.
 */
function delimiterOf(text: string): Delimiter {
  const named = /^sep=(.)\r?\n/.exec(text)?.[1];
  const found = DELIMITERS.find((delimiter) => delimiter === named);
  if (found !== undefined) return found;
  const lines = text
    .slice(0, 64 * 1024)
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .slice(0, 20);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => line.replaceAll(/"[^"]*"/g, "").split(delimiter).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    // The lines that use it as often as the first one, then how often that is.
    const score = counts.filter((count) => count === first).length * 1000 + first;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A CSV or TSV file as one table: quoted fields with their delimiters, quotes
 * and line breaks, up to `rows` rows and `columns` columns, and every row as
 * wide as the widest.
 */
export function readCsv(text: string): DocumentContent {
  const delimiter = delimiterOf(text);
  const start = /^sep=.\r?\n/.exec(text)?.[0].length ?? 0;
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let field = "";
  let quoted = false;
  let cut = false;
  let columns = 0;
  const endField = () => {
    if (row.length < DOCUMENT_LIMITS.columns) row.push(clip(field, DOCUMENT_LIMITS.cellCharacters));
    else cut = true;
    field = "";
  };
  const endRow = () => {
    endField();
    columns = Math.max(columns, row.length);
    rows.push(row);
    row = [];
  };
  let at = start;
  for (; at < text.length && rows.length < DOCUMENT_LIMITS.rows; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      endRow();
    } else {
      field += char;
    }
  }
  if (at < text.length) cut = true;
  else if (field !== "" || row.length > 0) endRow();
  for (const each of rows) while (each.length < columns) each.push("");
  return { _tag: "sheets", sheets: [{ name: null, rows, columns, cut }], cut: false };
}
