// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { Block, DocumentContent, DocumentImage, Run, Slide } from "./model.ts";
import { addRun, linkedParts, mainPart, pictures, plainText, switchedOn } from "./office.ts";
import { Refused } from "./text.ts";
import { numberAs } from "./word.ts";
import {
  childNamed,
  childrenNamed,
  descendantsNamed,
  pathOf,
  type XmlElement,
  xmlTree,
} from "./xml.ts";
import { openZip } from "./zip.ts";

/**
 * A PowerPoint presentation (pptx) as its slides, in order, each as its
 * title and what is on it: text with its bullets and numbers, tables and
 * pictures. Not where things are placed, their colors, shapes, animations or
 * speaker notes: a faithful drawing of a slide needs its fonts, themes and
 * layout engine, which a viewer of untrusted files has no business holding.
 * A hidden slide is left out, as a slide show leaves it out.
 */
export function readSlides(bytes: Uint8Array): DocumentContent {
  const zip = openZip(bytes);
  const main = mainPart(zip, "ppt/presentation.xml");
  const source = zip.text(main);
  if (source === null) throw new Refused({ reason: "unreadable" });
  const linked = linkedParts(zip, main);
  const picture = pictures(zip);
  const listed = pathOf(xmlTree(source), "p:sldIdLst");
  const ids = listed === undefined ? [] : childrenNamed(listed, "p:sldId");
  const slides: Array<Slide> = [];
  let cut = false;
  for (const entry of ids) {
    const id = entry.attributes.get("r:id");
    const part = id === undefined ? undefined : linked.get(id);
    const xml = part === undefined ? null : zip.text(part);
    if (part === undefined || xml === null) continue;
    const slide = xmlTree(xml);
    if (!switchedOn(slide.attributes.get("show"))) continue;
    if (slides.length >= DOCUMENT_LIMITS.slides) {
      cut = true;
      break;
    }
    const slideLinks = linkedParts(zip, part);
    const reader: SlideReading = { title: null, blocks: [] };
    const tree = pathOf(slide, "p:cSld", "p:spTree");
    if (tree !== undefined) {
      shapes(tree, reader, (embed) => {
        const target = slideLinks.get(embed);
        return target === undefined ? null : picture(target);
      });
    }
    slides.push(reader);
  }
  return { _tag: "slides", slides, cut };
}

interface SlideReading {
  title: string | null;
  readonly blocks: Array<Block>;
}

/** What the shapes of a slide's tree show, in the order they were placed. */
function shapes(
  tree: XmlElement,
  reading: SlideReading,
  image: (embed: string) => DocumentImage | null,
): void {
  for (const shape of tree.children) {
    if (typeof shape === "string") continue;
    switch (shape.name) {
      case "p:sp":
        textShape(shape, reading);
        break;
      case "p:pic": {
        const embed = pathOf(shape, "p:blipFill", "a:blip")?.attributes.get("r:embed");
        const found = embed === undefined ? null : image(embed);
        const alt = pathOf(shape, "p:nvPicPr", "p:cNvPr")?.attributes.get("descr") ?? "";
        if (found !== null) reading.blocks.push({ _tag: "image", image: found, alt });
        break;
      }
      case "p:graphicFrame":
        for (const table of descendantsNamed(shape, "a:tbl")) {
          const rows = childrenNamed(table, "a:tr")
            .slice(0, DOCUMENT_LIMITS.rows)
            .map((row) =>
              childrenNamed(row, "a:tc")
                .slice(0, DOCUMENT_LIMITS.columns)
                .map((cell) =>
                  descendantsNamed(cell, "a:p")
                    .map((paragraph) => plainText(runsOf(paragraph)))
                    .join("\n")
                    .slice(0, DOCUMENT_LIMITS.cellCharacters),
                ),
            );
          if (rows.length > 0) reading.blocks.push({ _tag: "table", rows, header: true });
        }
        break;
      case "p:grpSp":
        shapes(shape, reading, image);
        break;
      case "mc:AlternateContent": {
        const choice = childNamed(shape, "mc:Choice");
        if (choice !== undefined) shapes(choice, reading, image);
        break;
      }
    }
  }
}

const TITLES: ReadonlySet<string> = new Set(["title", "ctrTitle"]);
/** Placeholders whose paragraphs are bulleted unless a paragraph says otherwise. */
const BULLETED: ReadonlySet<string> = new Set(["body", "obj"]);

/** A shape's text: the slide's title, or its paragraphs, bulleted as they say. */
function textShape(shape: XmlElement, reading: SlideReading): void {
  const body = childNamed(shape, "p:txBody");
  if (body === undefined) return;
  const placeholder = pathOf(shape, "p:nvSpPr", "p:nvPr", "p:ph");
  // A placeholder with no type is the slide's body.
  const kind = placeholder === undefined ? null : (placeholder.attributes.get("type") ?? "obj");
  const paragraphs = childrenNamed(body, "a:p");
  if (kind !== null && TITLES.has(kind)) {
    const title = paragraphs
      .map((paragraph) => plainText(runsOf(paragraph)))
      .join(" ")
      .trim();
    if (title === "") return;
    if (reading.title === null) reading.title = title;
    else reading.blocks.push({ _tag: "heading", level: 3, runs: [plainRun(title)] });
    return;
  }
  const bulleted = kind !== null && BULLETED.has(kind);
  const counts: Array<number> = [];
  for (const paragraph of paragraphs) {
    const runs = runsOf(paragraph);
    if (plainText(runs).trim() === "") continue;
    const properties = childNamed(paragraph, "a:pPr");
    const depth = Math.min(Math.max(Number(properties?.attributes.get("lvl") ?? "0") || 0, 0), 8);
    const marker = markerOf(properties, bulleted, depth, counts);
    reading.blocks.push(
      marker === null ? { _tag: "paragraph", runs } : { _tag: "item", depth, marker, runs },
    );
  }
}

const plainRun = (text: string): Run => ({ text, bold: false, italic: false, code: false });

/** A paragraph's runs: text in bold and italic as it says, and its line breaks. */
function runsOf(paragraph: XmlElement): Array<Run> {
  const runs: Array<Run> = [];
  for (const child of paragraph.children) {
    if (typeof child === "string") continue;
    if (child.name === "a:r" || child.name === "a:fld") {
      const properties = childNamed(child, "a:rPr");
      const text = childNamed(child, "a:t");
      addRun(
        runs,
        text === undefined ? "" : text.children.filter((part) => typeof part === "string").join(""),
        {
          bold:
            properties !== undefined &&
            ["1", "true"].includes(properties.attributes.get("b") ?? ""),
          italic:
            properties !== undefined &&
            ["1", "true"].includes(properties.attributes.get("i") ?? ""),
          code: false,
        },
      );
    } else if (child.name === "a:br") {
      addRun(runs, "\n", { bold: false, italic: false, code: false });
    }
  }
  return runs;
}

/** A paragraph's bullet or number, counted on in `counts`; null for none. */
function markerOf(
  properties: XmlElement | undefined,
  bulleted: boolean,
  depth: number,
  counts: Array<number>,
): string | null {
  if (properties !== undefined && childNamed(properties, "a:buNone") !== undefined) return null;
  const numbered = properties === undefined ? undefined : childNamed(properties, "a:buAutoNum");
  if (numbered !== undefined) {
    const scheme = numbered.attributes.get("type") ?? "arabicPeriod";
    const start = Number(numbered.attributes.get("startAt") ?? "1") || 1;
    counts[depth] = (counts[depth] ?? start - 1) + 1;
    counts.length = depth + 1;
    return numberMarker(scheme, counts[depth] ?? start);
  }
  counts.length = depth;
  const written =
    properties === undefined
      ? undefined
      : childNamed(properties, "a:buChar")?.attributes.get("char");
  if (written !== undefined || bulleted) return "•";
  return null;
}

/** A number as an auto-numbering scheme writes it: `alphaLcParenR` makes 3 "c)". */
function numberMarker(scheme: string, count: number): string {
  const format = scheme.startsWith("alphaLc")
    ? "lowerLetter"
    : scheme.startsWith("alphaUc")
      ? "upperLetter"
      : scheme.startsWith("romanLc")
        ? "lowerRoman"
        : scheme.startsWith("romanUc")
          ? "upperRoman"
          : "decimal";
  const number = numberAs(format, count);
  if (scheme.endsWith("ParenBoth")) return `(${number})`;
  if (scheme.endsWith("ParenR")) return `${number})`;
  if (scheme.endsWith("Plain")) return number;
  return `${number}.`;
}
