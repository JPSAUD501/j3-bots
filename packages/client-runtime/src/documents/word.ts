// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { Block, DocumentContent, DocumentImage, Run } from "./model.ts";
import { addRun, linkedParts, mainPart, pictures, plainText, switchedOn } from "./office.ts";
import { Refused } from "./text.ts";
import {
  childNamed,
  childrenNamed,
  descendantsNamed,
  pathOf,
  textOf,
  type XmlElement,
  xmlTree,
} from "./xml.ts";
import { openZip, type Zip } from "./zip.ts";

/**
 * A Word document (docx) as a flow of blocks: its headings, paragraphs in
 * bold and italic, lists with their numbers, tables as their text, and
 * pictures. Not its layout: fonts, colors, columns, headers, footers,
 * comments, notes, text boxes and tracked deletions are left out, and a link
 * is its text.
 */
export function readWord(bytes: Uint8Array): DocumentContent {
  const zip = openZip(bytes);
  const main = mainPart(zip, "word/document.xml");
  const source = zip.text(main);
  if (source === null) throw new Refused({ reason: "unreadable" });
  const body = pathOf(xmlTree(source), "w:body");
  if (body === undefined) throw new Refused({ reason: "unreadable" });
  const reader = new WordReader(
    zip,
    main,
    stylesOf(zip.text("word/styles.xml")),
    numberingOf(zip.text("word/numbering.xml")),
  );
  reader.container(body);
  return { _tag: "flow", blocks: reader.blocks, pages: pagesOf(zip), cut: reader.cut };
}

/** How Word marks a run on or off: `<w:b/>` is on, `<w:b w:val="0"/>` off, no `w:b` off. */
const flag = (properties: XmlElement | undefined, name: string): boolean => {
  const element = properties === undefined ? undefined : childNamed(properties, name);
  return element !== undefined && switchedOn(element.attributes.get("w:val"));
};

const value = (element: XmlElement | undefined, name: string): string | undefined =>
  element === undefined ? undefined : childNamed(element, name)?.attributes.get("w:val");

/** Parts of a paragraph that hold its runs, or more such parts. */
const INLINE_CONTAINERS: ReadonlySet<string> = new Set([
  "w:hyperlink",
  "w:ins",
  "w:moveTo",
  "w:smartTag",
  "w:fldSimple",
  "w:customXml",
  "w:dir",
  "w:bdo",
]);

/** Parts of a body that hold paragraphs and tables. */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set(["w:customXml", "w:ins", "w:moveTo"]);

interface Level {
  readonly format: string;
  readonly start: number;
  readonly text: string;
}

class WordReader {
  readonly blocks: Array<Block> = [];
  cut = false;
  readonly #linked: ReadonlyMap<string, string>;
  readonly #picture: (part: string) => DocumentImage | null;
  readonly #styles: Styles;
  readonly #numbering: ReadonlyMap<string, ReadonlyArray<Level>>;
  /** Each list's count at each of its levels, by its id. */
  readonly #counts = new Map<string, Array<number>>();

  constructor(
    zip: Zip,
    main: string,
    styles: Styles,
    numbering: ReadonlyMap<string, ReadonlyArray<Level>>,
  ) {
    this.#linked = linkedParts(zip, main);
    this.#picture = pictures(zip);
    this.#styles = styles;
    this.#numbering = numbering;
  }

  push(block: Block) {
    if (this.blocks.length >= DOCUMENT_LIMITS.blocks) this.cut = true;
    else this.blocks.push(block);
  }

  container(element: XmlElement) {
    for (const child of element.children) {
      if (this.cut) return;
      if (typeof child === "string") continue;
      if (child.name === "w:p") this.paragraph(child);
      else if (child.name === "w:tbl") this.table(child);
      else if (child.name === "w:sdt") {
        const content = childNamed(child, "w:sdtContent");
        if (content !== undefined) this.container(content);
      } else if (BLOCK_CONTAINERS.has(child.name)) this.container(child);
    }
  }

  paragraph(paragraph: XmlElement) {
    const runs: Array<Run> = [];
    const images: Array<DocumentImage> = [];
    this.inline(paragraph, runs, images);
    const properties = childNamed(paragraph, "w:pPr");
    const text = plainText(runs);
    if (text.trim() !== "") {
      const style = value(properties, "w:pStyle");
      const outline = Number(value(properties, "w:outlineLvl"));
      const level =
        (style === undefined ? undefined : this.#styles.headings.get(style)) ??
        (Number.isInteger(outline) && outline >= 0 && outline < 5 ? outline + 2 : undefined);
      // Numbered by the paragraph itself, or by its style, as Word's "List Bullet" is.
      const listed =
        (properties === undefined ? undefined : childNamed(properties, "w:numPr")) ??
        (style === undefined ? undefined : this.#styles.lists.get(style));
      const marker = listed === undefined ? null : this.marker(listed);
      if (level !== undefined) this.push({ _tag: "heading", level, runs });
      else if (marker !== null) this.push({ _tag: "item", ...marker, runs });
      else this.push({ _tag: "paragraph", runs });
    }
    for (const image of images) this.push({ _tag: "image", image, alt: "" });
  }

  /** The runs and pictures of a paragraph's content, in order. */
  inline(element: XmlElement, runs: Array<Run>, images: Array<DocumentImage>) {
    for (const child of element.children) {
      if (typeof child === "string") continue;
      if (child.name === "w:r") this.run(child, runs, images);
      else if (INLINE_CONTAINERS.has(child.name)) this.inline(child, runs, images);
      else if (child.name === "w:sdt") {
        const content = childNamed(child, "w:sdtContent");
        if (content !== undefined) this.inline(content, runs, images);
      } else if (child.name === "mc:AlternateContent") {
        const choice = childNamed(child, "mc:Choice");
        if (choice !== undefined) this.inline(choice, runs, images);
      }
    }
  }

  run(run: XmlElement, runs: Array<Run>, images: Array<DocumentImage>) {
    const properties = childNamed(run, "w:rPr");
    const style = { bold: flag(properties, "w:b"), italic: flag(properties, "w:i"), code: false };
    for (const child of run.children) {
      if (typeof child === "string") continue;
      switch (child.name) {
        case "w:t":
          addRun(runs, textOf(child, "w:t"), style);
          break;
        case "w:tab":
          addRun(runs, "\t", style);
          break;
        case "w:br":
        case "w:cr":
          if (child.attributes.get("w:type") !== "page") addRun(runs, "\n", style);
          break;
        case "w:noBreakHyphen":
          addRun(runs, "-", style);
          break;
        case "w:drawing":
        case "w:pict":
        case "w:object":
        case "mc:AlternateContent":
          this.images(child, images);
          break;
      }
    }
  }

  /** The pictures a drawing shows: DrawingML's `a:blip`, and VML's `v:imagedata`. */
  images(drawing: XmlElement, images: Array<DocumentImage>) {
    const choice =
      drawing.name === "mc:AlternateContent"
        ? (childNamed(drawing, "mc:Choice") ?? drawing)
        : drawing;
    const ids = [
      ...descendantsNamed(choice, "a:blip").map((blip) => blip.attributes.get("r:embed")),
      ...descendantsNamed(choice, "v:imagedata").map((data) => data.attributes.get("r:id")),
    ];
    for (const id of ids) {
      const part = id === undefined ? undefined : this.#linked.get(id);
      const image = part === undefined ? null : this.#picture(part);
      if (image !== null) images.push(image);
    }
  }

  /** A numbered paragraph's place in its list: its depth and its marker, counted on. */
  marker(numbered: XmlElement): { readonly depth: number; readonly marker: string } | null {
    const id = value(numbered, "w:numId");
    const depth = Math.min(Math.max(Number(value(numbered, "w:ilvl") ?? "0") || 0, 0), 8);
    if (id === undefined || id === "0") return null;
    const levels = this.#numbering.get(id);
    const level = levels?.[depth];
    if (levels === undefined || level === undefined || level.format === "none") {
      return { depth, marker: bullet(depth) };
    }
    const counts = this.#counts.get(id) ?? [];
    counts[depth] = (counts[depth] ?? level.start - 1) + 1;
    counts.length = depth + 1;
    this.#counts.set(id, counts);
    if (level.format === "bullet") return { depth, marker: bullet(depth) };
    const marker = level.text.replaceAll(/%([1-9])/g, (written, digit: string) => {
      const at = Number(digit) - 1;
      const count = counts[at] ?? levels[at]?.start ?? 1;
      return numberAs(levels[at]?.format ?? "decimal", count);
    });
    return { depth, marker: marker.trim() === "" ? `${counts[depth]}.` : marker };
  }

  table(table: XmlElement) {
    const rows: Array<Array<string>> = [];
    for (const row of childrenNamed(table, "w:tr")) {
      if (rows.length >= DOCUMENT_LIMITS.rows) {
        this.cut = true;
        break;
      }
      rows.push(
        childrenNamed(row, "w:tc")
          .slice(0, DOCUMENT_LIMITS.columns)
          .map((cell) =>
            descendantsNamed(cell, "w:p")
              .map((paragraph) => {
                const runs: Array<Run> = [];
                this.inline(paragraph, runs, []);
                return plainText(runs);
              })
              .join("\n")
              .slice(0, DOCUMENT_LIMITS.cellCharacters),
          ),
      );
    }
    const first = childrenNamed(table, "w:tr")[0];
    const header = first !== undefined && flag(childNamed(first, "w:trPr"), "w:tblHeader");
    if (rows.length > 0) this.push({ _tag: "table", rows, header });
  }
}

const BULLETS = ["•", "◦", "▪"] as const;
const bullet = (depth: number) => BULLETS[depth % BULLETS.length] ?? "•";

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

const roman = (count: number) => {
  let left = Math.min(Math.max(count, 1), 3999);
  let text = "";
  for (const [size, letters] of ROMAN) {
    while (left >= size) {
      text += letters;
      left -= size;
    }
  }
  return text;
};

const letters = (count: number) => {
  const letter = String.fromCharCode(97 + ((Math.max(count, 1) - 1) % 26));
  return letter.repeat(Math.floor((Math.max(count, 1) - 1) / 26) + 1);
};

/** A list's count as its level writes it: 3 as "3", "c", "C", "iii", "III" or "03". */
export function numberAs(format: string, count: number): string {
  switch (format) {
    case "lowerLetter":
      return letters(count);
    case "upperLetter":
      return letters(count).toUpperCase();
    case "lowerRoman":
      return roman(count);
    case "upperRoman":
      return roman(count).toUpperCase();
    case "decimalZero":
      return String(count).padStart(2, "0");
    default:
      return String(count);
  }
}

/** What the paragraph styles that matter here make of a paragraph, by style id. */
interface Styles {
  /** A heading's level: the title 1, "heading 1" 2 and on, a style with an outline level that plus 2. */
  readonly headings: ReadonlyMap<string, number>;
  /** The list a style numbers its paragraphs in (`w:numPr`). */
  readonly lists: ReadonlyMap<string, XmlElement>;
}

function stylesOf(source: string | null): Styles {
  const headings = new Map<string, number>();
  const lists = new Map<string, XmlElement>();
  if (source === null) return { headings, lists };
  for (const style of childrenNamed(xmlTree(source), "w:style")) {
    const id = style.attributes.get("w:styleId");
    if (id === undefined || style.attributes.get("w:type") !== "paragraph") continue;
    const name = (value(style, "w:name") ?? "").toLowerCase();
    const heading = /^heading ([1-9])$/.exec(name)?.[1];
    const properties = childNamed(style, "w:pPr");
    const outline = Number(value(properties, "w:outlineLvl"));
    const level =
      name === "title"
        ? 1
        : heading !== undefined
          ? Number(heading) + 1
          : Number.isInteger(outline) && outline >= 0 && outline < 5
            ? outline + 2
            : undefined;
    if (level !== undefined) headings.set(id, Math.min(level, 6));
    const listed = properties === undefined ? undefined : childNamed(properties, "w:numPr");
    if (listed !== undefined) lists.set(id, listed);
  }
  return { headings, lists };
}

/** Each list's levels, by the list's id: how each counts and writes its number. */
function numberingOf(source: string | null): ReadonlyMap<string, ReadonlyArray<Level>> {
  const lists = new Map<string, ReadonlyArray<Level>>();
  if (source === null) return lists;
  const numbering = xmlTree(source);
  const abstract = new Map<string, ReadonlyArray<Level>>();
  for (const definition of childrenNamed(numbering, "w:abstractNum")) {
    const id = definition.attributes.get("w:abstractNumId");
    if (id === undefined) continue;
    const levels: Array<Level> = [];
    for (const level of childrenNamed(definition, "w:lvl")) {
      const at = Number(level.attributes.get("w:ilvl"));
      if (!Number.isInteger(at) || at < 0 || at > 8) continue;
      levels[at] = {
        format: value(level, "w:numFmt") ?? "decimal",
        start: Number(value(level, "w:start") ?? "1") || 1,
        text: value(level, "w:lvlText") ?? `%${at + 1}.`,
      };
    }
    abstract.set(id, levels);
  }
  for (const list of childrenNamed(numbering, "w:num")) {
    const id = list.attributes.get("w:numId");
    const definition = value(list, "w:abstractNumId");
    const levels = definition === undefined ? undefined : abstract.get(definition);
    if (id !== undefined && levels !== undefined) lists.set(id, levels);
  }
  return lists;
}

/** The pages the document had when it was last saved, as the file says; null when it does not. */
function pagesOf(zip: Zip): number | null {
  const source = zip.text("docProps/app.xml");
  if (source === null) return null;
  try {
    const pages = descendantsNamed(xmlTree(source), "Pages")[0];
    const count = pages === undefined ? Number.NaN : Number(textOf(pages, "Pages"));
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}
