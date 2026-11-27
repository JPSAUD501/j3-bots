// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { DocumentContent, Sheet } from "./model.ts";
import { clip, linkedParts, mainPart } from "./office.ts";
import { Refused } from "./text.ts";
import {
  childNamed,
  childrenNamed,
  descendantsNamed,
  type XmlElement,
  xmlEvents,
  xmlTree,
} from "./xml.ts";
import { openZip, type Zip } from "./zip.ts";

/**
 * An Excel workbook (xlsx) as its visible sheets, each as the text its cells
 * show: shared and inline strings, numbers in the reader's language, dates
 * and percentages as their format says, and a formula as its last result. Not
 * colors, borders, merged cells, charts or pictures. Each sheet is read up to
 * `rows` and `columns`, and the reading stops there.
 */
export function readSheets(bytes: Uint8Array, locale: string): DocumentContent {
  const zip = openZip(bytes);
  const main = mainPart(zip, "xl/workbook.xml");
  const source = zip.text(main);
  if (source === null) throw new Refused({ reason: "unreadable" });
  const workbook = xmlTree(source);
  const linked = linkedParts(zip, main);
  const strings = sharedStrings(zip, linked);
  const formats = cellFormats(zip, linked);
  const date1904 = workbook.children.some(
    (child) =>
      typeof child !== "string" &&
      child.name === "workbookPr" &&
      ["1", "true"].includes(child.attributes.get("date1904") ?? ""),
  );
  const show = shower(locale, formats, date1904);
  const listed = childrenNamed(childNamed(workbook, "sheets") ?? workbook, "sheet").filter(
    (sheet) => (sheet.attributes.get("state") ?? "visible") === "visible",
  );
  const sheets: Array<Sheet> = [];
  for (const sheet of listed.slice(0, DOCUMENT_LIMITS.sheets)) {
    const id = sheet.attributes.get("r:id");
    const part = id === undefined ? undefined : linked.get(id);
    const xml = part === undefined ? null : zip.text(part);
    // A chart sheet or a dialog sheet has no cells: it shows as an empty sheet.
    sheets.push(
      xml === null || !part?.includes("worksheets/")
        ? { name: sheet.attributes.get("name") ?? "", rows: [], columns: 0, cut: false }
        : readWorksheet(sheet.attributes.get("name") ?? "", xml, strings, show),
    );
  }
  return { _tag: "sheets", sheets, cut: listed.length > DOCUMENT_LIMITS.sheets };
}

/** A column's number from its letters: A is 0, Z 25, AA 26. */
const columnIndex = (letters: string): number => {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

/** Reads a worksheet's cells as events, stopping past the rows shown. */
function readWorksheet(
  name: string,
  source: string,
  strings: ReadonlyArray<string>,
  show: (value: string, type: string, style: number) => string,
): Sheet {
  const rows: Array<Array<string>> = [];
  let cut = false;
  let columns = 0;
  let row: Array<string> | null = null;
  let nextRow = 0;
  let nextColumn = 0;
  let cell: { column: number; type: string; style: number } | null = null;
  // The text being gathered, and which element it is for: a cell's value or an inline string.
  let gathering: "value" | "inline" | null = null;
  let value = "";
  let inline = "";
  for (const event of xmlEvents(source)) {
    if (event._tag === "open") {
      switch (event.name) {
        case "row": {
          const number = Number(event.attributes.get("r"));
          // Rows come in order; one numbered at or before the last is taken as the next,
          // so every row read counts toward the limit.
          const at = Number.isInteger(number) && number - 1 >= nextRow ? number - 1 : nextRow;
          if (at >= DOCUMENT_LIMITS.rows) {
            cut = true;
            return finish(name, rows, columns, cut);
          }
          while (rows.length < at) rows.push([]);
          row = [];
          rows.push(row);
          nextRow = at + 1;
          nextColumn = 0;
          break;
        }
        case "c": {
          const reference = /^([A-Z]+)/i.exec(event.attributes.get("r") ?? "")?.[1];
          const column = reference === undefined ? nextColumn : columnIndex(reference);
          nextColumn = column + 1;
          cell = {
            column,
            type: event.attributes.get("t") ?? "n",
            style: Number(event.attributes.get("s") ?? "0") || 0,
          };
          value = "";
          inline = "";
          break;
        }
        case "v":
          gathering = "value";
          break;
        case "t":
          if (cell?.type === "inlineStr") gathering = "inline";
          break;
        case "rPh":
          // A reading aid for East Asian text, not part of what the cell shows.
          gathering = null;
          break;
      }
      continue;
    }
    if (event._tag === "text") {
      if (gathering === "value") value += event.text;
      else if (gathering === "inline") inline += event.text;
      continue;
    }
    switch (event.name) {
      case "v":
      case "t":
        gathering = null;
        break;
      case "c": {
        if (cell !== null && row !== null) {
          if (cell.column >= DOCUMENT_LIMITS.columns) {
            cut = true;
          } else if (cell.column >= 0) {
            const shown =
              cell.type === "s"
                ? (strings[Number(value)] ?? "")
                : cell.type === "inlineStr"
                  ? inline
                  : show(value, cell.type, cell.style);
            if (shown !== "") {
              while (row.length < cell.column) row.push("");
              row[cell.column] = clip(shown, DOCUMENT_LIMITS.cellCharacters);
              columns = Math.max(columns, cell.column + 1);
            }
          }
        }
        cell = null;
        break;
      }
      case "row":
        row = null;
        break;
    }
  }
  return finish(name, rows, columns, cut);
}

/** The sheet with its empty rows at the end dropped, and every row as wide as the widest. */
function finish(name: string, rows: Array<Array<string>>, columns: number, cut: boolean): Sheet {
  while (rows.length > 0 && (rows.at(-1)?.length ?? 0) === 0) rows.pop();
  for (const row of rows) while (row.length < columns) row.push("");
  return { name, rows, columns, cut };
}

/** The workbook's shared strings, in order: each as the text it shows. */
function sharedStrings(zip: Zip, linked: ReadonlyMap<string, string>): ReadonlyArray<string> {
  const part =
    [...linked.values()].find((target) => target.endsWith("sharedStrings.xml")) ??
    "xl/sharedStrings.xml";
  const source = zip.text(part);
  if (source === null) return [];
  const strings: Array<string> = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  let characters = 0;
  for (const event of xmlEvents(source)) {
    if (event._tag === "open") {
      if (event.name === "si") current = "";
      else if (event.name === "rPh") phonetic += 1;
      else if (event.name === "t" && phonetic === 0) inText = true;
    } else if (event._tag === "close") {
      if (event.name === "si" && current !== null) {
        characters += current.length;
        if (characters > DOCUMENT_LIMITS.textCharacters * 8)
          throw new Refused({ reason: "tooBig" });
        strings.push(current);
        current = null;
      } else if (event.name === "rPh") phonetic -= 1;
      else if (event.name === "t") inText = false;
    } else if (inText && current !== null) {
      current += event.text;
    }
  }
  return strings;
}

/** What a cell's number shows as: a date (with a time or not), a percentage, or a number. */
type Shape = "date" | "dateTime" | "time" | "percent" | "number";

// Excel's built-in formats: 14 to 17 and 22 are dates, 18 to 21 and 45 to 47 times, 9 and 10 percentages.
const BUILT_IN: ReadonlyMap<number, Shape> = new Map([
  [9, "percent"],
  [10, "percent"],
  [14, "date"],
  [15, "date"],
  [16, "date"],
  [17, "date"],
  [18, "time"],
  [19, "time"],
  [20, "time"],
  [21, "time"],
  [22, "dateTime"],
  [45, "time"],
  [46, "time"],
  [47, "time"],
]);

/** The shape a custom number format gives a number, from its code outside quotes and brackets. */
function shapeOfFormat(code: string): Shape {
  const bare =
    code
      .replaceAll(/"[^"]*"/g, "")
      .replaceAll(/\[[^\]]*\]/g, "")
      .replaceAll(/\\./g, "")
      .split(";")[0]
      ?.toLowerCase() ?? "";
  const day = /[dy]/.test(bare) || /m{3,}/.test(bare) || (/m/.test(bare) && !/[hs]/.test(bare));
  const time = /[hs]/.test(bare);
  if (day && time) return "dateTime";
  if (day) return "date";
  if (time) return "time";
  return bare.includes("%") ? "percent" : "number";
}

/** The shape of each cell style, by its index (`s`). */
function cellFormats(zip: Zip, linked: ReadonlyMap<string, string>): ReadonlyArray<Shape> {
  const part =
    [...linked.values()].find((target) => target.endsWith("styles.xml")) ?? "xl/styles.xml";
  const source = zip.text(part);
  if (source === null) return [];
  const styles = xmlTree(source);
  const custom = new Map<number, Shape>();
  for (const format of descendantsNamed(styles, "numFmt")) {
    const id = Number(format.attributes.get("numFmtId"));
    if (Number.isInteger(id))
      custom.set(id, shapeOfFormat(format.attributes.get("formatCode") ?? ""));
  }
  const cells = childNamed(styles, "cellXfs");
  return cells === undefined
    ? []
    : childrenNamed(cells, "xf").map((xf: XmlElement) => {
        const id = Number(xf.attributes.get("numFmtId") ?? "0");
        return custom.get(id) ?? BUILT_IN.get(id) ?? "number";
      });
}

const DAY = 86_400_000;
// Day 0 of each date system, in UTC: 1899-12-30 (for 1900, past Excel's phantom 29 February) and 1904-01-01.
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** How a cell's stored value shows, by its type and style, in the reader's language. */
function shower(locale: string, shapes: ReadonlyArray<Shape>, date1904: boolean) {
  const number = new Intl.NumberFormat(locale, {
    maximumSignificantDigits: 15,
    useGrouping: false,
  });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const options = { timeZone: "UTC" } as const;
  const date = new Intl.DateTimeFormat(locale, { ...options, dateStyle: "short" });
  const dateTime = new Intl.DateTimeFormat(locale, {
    ...options,
    dateStyle: "short",
    timeStyle: "short",
  });
  const time = new Intl.DateTimeFormat(locale, { ...options, timeStyle: "short" });
  return (value: string, type: string, style: number): string => {
    switch (type) {
      case "b":
        return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
      case "n": {
        const stored = Number(value);
        if (value.trim() === "" || !Number.isFinite(stored)) return value;
        const shape = shapes[style] ?? "number";
        if (shape === "percent") return percent.format(stored);
        if (shape === "number") return number.format(stored);
        // Excel counts a 29 February 1900 that never was: days before it are one more than they are.
        const days = !date1904 && stored < 60 ? stored + 1 : stored;
        const when = (date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(days * DAY);
        if (!Number.isFinite(when) || Math.abs(when) > 8.64e15) return number.format(stored);
        return (shape === "date" ? date : shape === "time" ? time : dateTime).format(when);
      }
      default:
        // A formula's text (`str`), an error (`e`) or an ISO date (`d`), as stored.
        return value;
    }
  };
}
