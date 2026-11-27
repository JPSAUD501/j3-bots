// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gallery's documents: one of each kind the viewer shows, made here from
 * fictional content, and the files that show its other states. Development only.
 */
import { DOCUMENT_LIMITS } from "@j3-bots/client-runtime/documents";
import { type Attachment, AttachmentId } from "@j3-bots/contracts";
import { strToU8, zipSync } from "fflate";

const attachment = (id: string, name: string, mediaType: string, size: number): Attachment => ({
  id: AttachmentId.make(`doc-${id}`),
  name,
  mediaType,
  size,
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export const SAMPLE_DOCUMENTS = {
  pdf: attachment("pdf", "Lease renewal.pdf", "application/pdf", 41_200),
  word: attachment("word", "Trip plan.docx", DOCX, 18_300),
  sheet: attachment("sheet", "Household budget.xlsx", XLSX, 9_800),
  csv: attachment("csv", "Plants to water.csv", "text/csv", 640),
  markdown: attachment("markdown", "Garden notes.md", "text/markdown", 1_150),
  text: attachment("text", "Packing list.txt", "text/plain", 420),
  slides: attachment("slides", "Book club.pptx", PPTX, 36_700),
  /** Past the size a card fetches: it shows as its kind and size. */
  large: attachment("large", "Scanned receipts.pdf", "application/pdf", 18_400_000),
  /** Named as a Word document, and no zip at all. */
  damaged: attachment("damaged", "Old minutes.docx", DOCX, 2_048),
  /** A spreadsheet that unpacks to more than a device reads. */
  tooBig: attachment("toobig", "Every transaction.xlsx", XLSX, 52_000),
  /** One whose bytes the server does not give. */
  unreachable: attachment("unreachable", "Insurance policy.pdf", "application/pdf", 88_000),
  /** One that never finishes arriving. */
  loading: attachment("loading", "Warranty.pdf", "application/pdf", 64_000),
} as const;

const encoder = new TextEncoder();

/** A PDF of `pages`, each a few lines of Helvetica, with a correct cross-reference table. */
function pdf(pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
  const objects: Array<string> = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objects.length + 1;
  add("");
  const kids: Array<number> = [];
  for (const lines of pages) {
    const text = lines
      .map((line, at) => {
        const size = at === 0 ? 22 : 12;
        const y = at === 0 ? 760 : 720 - at * 22;
        const escaped = line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
        return `BT /F1 ${size} Tf 64 ${y} Td (${escaped}) Tj ET`;
      })
      .join("\n");
    const rule = "0.85 0.85 0.85 RG 64 740 m 548 740 l S";
    const content = add(
      `<< /Length ${text.length + rule.length + 1} >>\nstream\n${rule}\n${text}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((body, at) => {
    offsets.push(out.length);
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

/** A small bar chart, as PNG bytes, drawn here. */
async function chart(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d");
  if (context !== null) {
    context.fillStyle = "#f6f4ef";
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = "#5b7fd6";
    [60, 96, 120, 84].forEach((height, at) =>
      context.fillRect(40 + at * 64, 160 - height, 40, height),
    );
    context.fillStyle = "#e2884c";
    context.fillRect(40 + 4 * 64 - 24, 30, 16, 130);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

const office = (main: string, type: string, parts: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${main}"/></Relationships>`,
        ...parts,
      }).map(([name, part]) => [name, typeof part === "string" ? strToU8(part) : part]),
    ),
  );

const para = (text: string, properties = "", run = "") =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}<w:r>${run === "" ? "" : `<w:rPr>${run}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function word(): Promise<Uint8Array> {
  const listed = (level: number) =>
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`;
  const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`;
  return office("word/document.xml", "officeDocument", {
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${[
      para("Trip to the coast", '<w:pStyle w:val="Title"/>'),
      `<w:p><w:r><w:t xml:space="preserve">Three days by the sea, leaving on </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Friday morning</w:t></w:r><w:r><w:t xml:space="preserve">. Bring </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>warm clothes</w:t></w:r><w:r><w:t>: the evenings are cold.</w:t></w:r></w:p>`,
      para("Before we go", '<w:pStyle w:val="Heading1"/>'),
      para("Book the cabin", listed(0)),
      para("Ask about pets", listed(1)),
      para("Pack the car", listed(0)),
      para("Days", '<w:pStyle w:val="Heading1"/>'),
      `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("Day")}${cell("Plan")}</w:tr><w:tr>${cell("Friday")}${cell("Drive, check in, dinner by the pier")}</w:tr><w:tr>${cell("Saturday")}${cell("Lighthouse walk")}</w:tr><w:tr>${cell("Sunday")}${cell("Market, then home")}</w:tr></w:tbl>`,
      `<w:p><w:r><w:drawing><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdChart"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></w:drawing></w:r></w:p>`,
      para("Fuel per day, so far."),
    ].join("")}</w:body></w:document>`,
    "word/_rels/document.xml.rels": `<Relationships><Relationship Id="rIdChart" Type="image" Target="media/chart.png"/></Relationships>`,
    "word/media/chart.png": await chart(),
    "word/styles.xml": `<w:styles><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    "word/numbering.xml": `<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "docProps/app.xml": "<Properties><Pages>2</Pages></Properties>",
  });
}

function workbook(): Uint8Array {
  const strings = [
    "Item",
    "Amount",
    "Due",
    "Share",
    "Rent",
    "Groceries",
    "Internet",
    "Water the ferns on Sundays",
  ];
  const s = (index: number, ref: string) => `<c r="${ref}" t="s"><v>${index}</v></c>`;
  const n = (value: number, ref: string, style = 0) =>
    `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  const rows = [
    `<row r="1">${s(0, "A1")}${s(1, "B1")}${s(2, "C1")}${s(3, "D1")}</row>`,
    `<row r="2">${s(4, "A2")}${n(1450, "B2")}${n(46_266, "C2", 1)}${n(0.52, "D2", 2)}</row>`,
    `<row r="3">${s(5, "A3")}${n(820.4, "B3")}${n(46_270, "C3", 1)}${n(0.29, "D3", 2)}</row>`,
    `<row r="4">${s(6, "A4")}${n(119.9, "B4")}${n(46_275, "C4", 1)}${n(0.04, "D4", 2)}</row>`,
  ].join("");
  return office("xl/workbook.xml", "officeDocument", {
    "xl/workbook.xml": `<workbook><sheets><sheet name="December" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rS" Type="sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rT" Type="styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1">${s(7, "A1")}</row></sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`,
    "xl/styles.xml": `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs></styleSheet>`,
  });
}

async function slides(): Promise<Uint8Array> {
  const shape = (placeholder: string, paragraphs: ReadonlyArray<string>) =>
    `<p:sp><p:nvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs
      .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp>`;
  const slide = (body: string) => `<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  return office("ppt/presentation.xml", "officeDocument", {
    "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/><p:sldId id="258" r:id="r3"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="r1" Type="slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="slide" Target="slides/slide2.xml"/><Relationship Id="r3" Type="slide" Target="slides/slide3.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(
      shape('<p:ph type="ctrTitle"/>', ["Book club: winter picks"]) +
        shape('<p:ph type="subTitle" idx="1"/>', ["Thursday, 7 pm, at Rosa’s"]),
    ),
    "ppt/slides/slide2.xml": slide(
      shape('<p:ph type="title"/>', ["The shortlist"]) +
        shape('<p:ph idx="1"/>', [
          "A quiet mystery set in a lighthouse",
          "A memoir about learning to sail",
          "Short stories from a mountain town",
        ]),
    ),
    "ppt/slides/slide3.xml": slide(
      shape('<p:ph type="title"/>', ["How we voted"]) +
        `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart" descr="Votes per book"/></p:nvPicPr><p:blipFill><a:blip r:embed="rC"/></p:blipFill></p:pic>`,
    ),
    "ppt/slides/_rels/slide3.xml.rels": `<Relationships><Relationship Id="rC" Type="image" Target="../media/chart.png"/></Relationships>`,
    "ppt/media/chart.png": await chart(),
  });
}

const CSV =
  'Plant;Room;Every;Last watered\nFern;Living room;3 days;24/11\nBasil;Kitchen;2 days;26/11\nCactus;Office;3 weeks;02/11\n"Monstera; big one";Hall;1 week;20/11\n';

const MARKDOWN = `# Garden notes

Things to do **before the first frost**, in order.

## This week

1. Bring the *basil* inside
2. Cover the raised beds
   - straw first, then the cloth
3. Drain the hose

- [x] Order bulbs
- [ ] Plant the bulbs

> Water in the morning, never at night.

| Bed | Planted | Next |
|---|---|---|
| North | Garlic | Mulch |
| South | Tulips | Wait |
`;

const TEXT =
  "Packing list\n\n- toothbrush\n- charger\n- rain jacket\n- two books\n- snacks for the drive\n\nDon’t forget to leave a key with Marta.\n";

/** The gallery's stand-in for the server's file bytes: null for the one it does not give. */
export async function sampleDocumentBytes(file: Attachment): Promise<Uint8Array | null> {
  switch (file.id) {
    case SAMPLE_DOCUMENTS.pdf.id:
    case "v-march":
    case "v-april":
      return pdf([
        [
          "Lease renewal",
          "Tenant: Rosa Lima",
          "Flat 4B, 12 Harbour Street",
          "Term: twelve months from 1 January",
          "Rent: as before, paid on the 5th",
        ],
        [
          "Signatures",
          "Both parties sign below.",
          "",
          "Tenant ____________________",
          "Landlord __________________",
        ],
      ]);
    case SAMPLE_DOCUMENTS.word.id:
      return word();
    case SAMPLE_DOCUMENTS.sheet.id:
      return workbook();
    case SAMPLE_DOCUMENTS.slides.id:
      return slides();
    case SAMPLE_DOCUMENTS.csv.id:
      return encoder.encode(CSV);
    case SAMPLE_DOCUMENTS.markdown.id:
      return encoder.encode(MARKDOWN);
    case SAMPLE_DOCUMENTS.text.id:
      return encoder.encode(TEXT);
    case SAMPLE_DOCUMENTS.damaged.id:
      return encoder.encode("These are not the minutes you are looking for.");
    case SAMPLE_DOCUMENTS.tooBig.id:
      return office("xl/workbook.xml", "officeDocument", {
        "xl/workbook.xml": `<workbook><sheets><sheet name="All" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": new Uint8Array(DOCUMENT_LIMITS.partBytes + 1),
      });
    case SAMPLE_DOCUMENTS.loading.id:
      return new Promise(() => {});
    default:
      return null;
  }
}
