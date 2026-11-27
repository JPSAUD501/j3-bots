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

/** How many digits a number format shows: zeros it pads to, decimals, and thousands apart. */
interface Digits {
  readonly integer: number;
  readonly fractionMin: number;
  readonly fractionMax: number;
  readonly grouping: boolean;
}

/**
 * What a cell's number shows as: a date (with a time or not), a time of day,
 * a duration that runs past a day (`[h]:mm:ss`), or a number or percentage
 * with the digits its format names; `null` digits for Excel's General.
 */
type Shape =
  | { readonly kind: "date" | "dateTime" | "time" }
  | { readonly kind: "elapsed"; readonly unit: "h" | "m" | "s"; readonly seconds: boolean }
  | { readonly kind: "number" | "percent"; readonly digits: Digits | null };

const GENERAL: Shape = { kind: "number", digits: null };
const digits = (integer: number, fraction: number, grouping: boolean): Digits => ({
  integer,
  fractionMin: fraction,
  fractionMax: fraction,
  grouping,
});

// Excel's built-in formats that are no General: 1 to 4 numbers, 9 and 10 percentages, 14 to 17
// and 22 dates, 18 to 21, 45 and 47 times, 46 a duration, 37 to 40 numbers in thousands.
const BUILT_IN: ReadonlyMap<number, Shape> = new Map<number, Shape>([
  [1, { kind: "number", digits: digits(1, 0, false) }],
  [2, { kind: "number", digits: digits(1, 2, false) }],
  [3, { kind: "number", digits: digits(1, 0, true) }],
  [4, { kind: "number", digits: digits(1, 2, true) }],
  [9, { kind: "percent", digits: digits(1, 0, false) }],
  [10, { kind: "percent", digits: digits(1, 2, false) }],
  [14, { kind: "date" }],
  [15, { kind: "date" }],
  [16, { kind: "date" }],
  [17, { kind: "date" }],
  [18, { kind: "time" }],
  [19, { kind: "time" }],
  [20, { kind: "time" }],
  [21, { kind: "time" }],
  [22, { kind: "dateTime" }],
  [37, { kind: "number", digits: digits(1, 0, true) }],
  [38, { kind: "number", digits: digits(1, 0, true) }],
  [39, { kind: "number", digits: digits(1, 2, true) }],
  [40, { kind: "number", digits: digits(1, 2, true) }],
  [45, { kind: "time" }],
  [46, { kind: "elapsed", unit: "h", seconds: true }],
  [47, { kind: "time" }],
]);

/** The digits a number format's placeholders name (`000042`, `#,##0.00`); null for any other. */
function digitsOf(bare: string): Digits | null {
  // Scientific notation, fractions and text are shown as General.
  if (/e[+-]|\/|@/.test(bare)) return null;
  const placeholders = bare.replaceAll(/[^0#?.,]/g, "");
  if (!/[0#?]/.test(placeholders)) return null;
  const point = placeholders.indexOf(".");
  const whole = point < 0 ? placeholders : placeholders.slice(0, point);
  const fraction = point < 0 ? "" : placeholders.slice(point + 1);
  return {
    integer: Math.min(Math.max(whole.split("0").length - 1, 1), 21),
    fractionMin: Math.min(fraction.split("0").length - 1, 20),
    fractionMax: Math.min(fraction.replaceAll(/[^0#?]/g, "").length, 20),
    grouping: /[0#?],[0#?]/.test(whole),
  };
}

/** The shape a custom number format gives a number, from its first section outside quotes. */
function shapeOfFormat(code: string): Shape {
  const section =
    code
      .replaceAll(/"[^"]*"/g, "")
      .replaceAll(/\\./g, "")
      .split(";")[0] ?? "";
  const elapsed = /\[(h+|m+|s+)\]/i.exec(section)?.[1]?.[0]?.toLowerCase();
  const bare = section.replaceAll(/\[[^\]]*\]/g, "").toLowerCase();
  if (elapsed === "h" || elapsed === "m" || elapsed === "s") {
    return { kind: "elapsed", unit: elapsed, seconds: elapsed === "s" || /s/.test(bare) };
  }
  const day = /[dy]/.test(bare) || /m{3,}/.test(bare) || (/m/.test(bare) && !/[hs]/.test(bare));
  const time = /[hs]/.test(bare);
  if (day && time) return { kind: "dateTime" };
  if (day) return { kind: "date" };
  if (time) return { kind: "time" };
  return { kind: bare.includes("%") ? "percent" : "number", digits: digitsOf(bare) };
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
        return custom.get(id) ?? BUILT_IN.get(id) ?? GENERAL;
      });
}

const DAY = 86_400_000;
// Day 0 of each date system, in UTC: 1899-12-30 (for 1900, past Excel's phantom 29 February) and 1904-01-01.
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** A duration of `days`, as `[h]:mm:ss` shows it: hours (or minutes, or seconds) past a day. */
function elapsedOf(days: number, shape: Extract<Shape, { kind: "elapsed" }>): string {
  const total = Math.round(Math.abs(days) * 86_400);
  const sign = days < 0 ? "-" : "";
  const two = (value: number) => String(value).padStart(2, "0");
  const seconds = total % 60;
  switch (shape.unit) {
    case "h": {
      const minutes = Math.floor(total / 60) % 60;
      const rest = shape.seconds ? `:${two(seconds)}` : "";
      return `${sign}${Math.floor(total / 3600)}:${two(minutes)}${rest}`;
    }
    case "m":
      return `${sign}${Math.floor(total / 60)}${shape.seconds ? `:${two(seconds)}` : ""}`;
    case "s":
      return `${sign}${total}`;
  }
}

/** How a cell's stored value shows, by its type and style, in the reader's language. */
function shower(locale: string, shapes: ReadonlyArray<Shape>, date1904: boolean) {
  const general = new Intl.NumberFormat(locale, {
    maximumSignificantDigits: 15,
    useGrouping: false,
  });
  const generalPercent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const formats = new Map<string, Intl.NumberFormat>();
  const numberIn = (style: "decimal" | "percent", shown: Digits) => {
    const key = `${style}:${shown.integer}:${shown.fractionMin}:${shown.fractionMax}:${shown.grouping}`;
    let format = formats.get(key);
    if (format === undefined) {
      format = new Intl.NumberFormat(locale, {
        style,
        minimumIntegerDigits: shown.integer,
        minimumFractionDigits: shown.fractionMin,
        maximumFractionDigits: shown.fractionMax,
        useGrouping: shown.grouping,
      });
      formats.set(key, format);
    }
    return format;
  };
  const options = { timeZone: "UTC" } as const;
  const date = new Intl.DateTimeFormat(locale, { ...options, dateStyle: "short" });
  const dateTime = new Intl.DateTimeFormat(locale, {
    ...options,
    dateStyle: "short",
    timeStyle: "short",
  });
  const time = new Intl.DateTimeFormat(locale, { ...options, timeStyle: "short" });
  const numberShown = (stored: number, shape: Shape): string => {
    switch (shape.kind) {
      case "number":
        return (shape.digits === null ? general : numberIn("decimal", shape.digits)).format(stored);
      case "percent":
        return (shape.digits === null ? generalPercent : numberIn("percent", shape.digits)).format(
          stored,
        );
      case "elapsed":
        return elapsedOf(stored, shape);
      case "date":
      case "dateTime":
      case "time": {
        // Excel counts a 29 February 1900 that never was: days before it are one more than they are.
        const days = !date1904 && stored < 60 ? stored + 1 : stored;
        const when = (date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(days * DAY);
        if (!Number.isFinite(when) || Math.abs(when) > 8.64e15) return general.format(stored);
        return (shape.kind === "date" ? date : shape.kind === "time" ? time : dateTime).format(
          when,
        );
      }
    }
  };
  return (value: string, type: string, style: number): string => {
    switch (type) {
      case "b":
        return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
      case "n": {
        const stored = Number(value);
        if (value.trim() === "" || !Number.isFinite(stored)) return value;
        return numberShown(stored, shapes[style] ?? GENERAL);
      }
      default:
        // A formula's text (`str`), an error (`e`) or an ISO date (`d`), as stored.
        return value;
    }
  };
}
