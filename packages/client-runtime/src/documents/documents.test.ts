// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { fileDetail } from "../wording/message.ts";
import { documentKind } from "./kinds.ts";
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { Block, DocumentContent, DocumentRead } from "./model.ts";
import { factsOf, type ReadKind, readDocument } from "./read.ts";

// The smallest PNG there is: one transparent pixel.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const zip = (parts: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, part]) => [
        name,
        typeof part === "string" ? strToU8(part) : part,
      ]),
    ),
  );

const read = (kind: ReadKind, bytes: Uint8Array, locale = "en"): DocumentContent => {
  const result: DocumentRead = readDocument(kind, bytes, locale);
  if (result._tag !== "read") throw new Error(`Expected the document to read, got ${result._tag}.`);
  return result.content;
};

const blocksOf = (content: DocumentContent): ReadonlyArray<Block> => {
  if (content._tag !== "flow") throw new Error(`Expected a flow, got ${content._tag}.`);
  return content.blocks;
};

/** Each block as a short line, to compare a flow at a glance. */
const lines = (blocks: ReadonlyArray<Block>) =>
  blocks.map((block) => {
    switch (block._tag) {
      case "heading":
        return `h${block.level} ${block.runs.map((run) => run.text).join("")}`;
      case "paragraph":
      case "quote":
        return `${block._tag === "quote" ? "> " : ""}${block.runs
          .map((run) =>
            run.bold
              ? `**${run.text}**`
              : run.italic
                ? `_${run.text}_`
                : run.code
                  ? `\`${run.text}\``
                  : run.text,
          )
          .join("")}`;
      case "item":
        return `${"  ".repeat(block.depth)}${block.marker} ${block.runs.map((run) => run.text).join("")}`;
      case "code":
        return `code ${block.text}`;
      case "table":
        return `table ${block.rows.map((row) => row.join("|")).join(" / ")}`;
      case "image":
        return `image ${block.image.mediaType}`;
      case "rule":
        return "rule";
    }
  });

describe("documentKind", () => {
  const kind = (name: string, mediaType: string, size = 10) =>
    documentKind({ name, mediaType, size });

  it("takes the kind from the media type, and from the name where the type says nothing", () => {
    expect(kind("report", "application/pdf")).toBe("pdf");
    expect(kind("budget.xlsx", "application/octet-stream")).toBe("sheet");
    expect(kind("notes.docx", "application/zip")).toBe("word");
    expect(kind("notes.docx", "")).toBe("word");
  });

  it("reads plain text named as Markdown or CSV as what its name says", () => {
    expect(kind("plan.md", "text/plain")).toBe("markdown");
    expect(kind("list.csv", "text/plain")).toBe("csv");
    expect(kind("plan.txt", "text/plain")).toBe("text");
  });

  it("shows no page, image or empty file, nor one a type contradicts", () => {
    expect(kind("page.html", "text/html")).toBeNull();
    expect(kind("photo.png", "image/png")).toBeNull();
    expect(kind("sheet.xlsx", "image/png")).toBeNull();
    expect(kind("empty.pdf", "application/pdf", 0)).toBeNull();
  });
});

describe("Word documents", () => {
  const word = (body: string, extra: Record<string, string | Uint8Array> = {}) =>
    zip({
      "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="r"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
      ...extra,
    });
  const p = (text: string, properties = "", run = "") =>
    `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}<w:r>${run === "" ? "" : `<w:rPr>${run}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const styles = `<w:styles>
    <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
    <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
  </w:styles>`;
  const numbering = `<w:numbering>
    <w:abstractNum w:abstractNumId="0">
      <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
      <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
    </w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  </w:numbering>`;
  const numbered = (level: number) =>
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`;

  it("reads headings, styled runs, numbered and bulleted lists, and tables, in order", () => {
    const content = read(
      "word",
      word(
        [
          p("Quarterly plan", '<w:pStyle w:val="Title"/>'),
          p("Goals", '<w:pStyle w:val="Heading1"/>'),
          `<w:p><w:r><w:t>Plain, </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t> and leaning</w:t></w:r></w:p>`,
          p("Hire", numbered(0)),
          p("Two people", numbered(1)),
          p("One more", numbered(1)),
          p("Ship", numbered(0)),
          p("Bullet by its style", '<w:pStyle w:val="ListBullet"/>'),
          `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${p("Who")}</w:tc><w:tc>${p("When")}</w:tc></w:tr><w:tr><w:tc>${p("Ana")}</w:tc><w:tc>${p("May")}</w:tc></w:tr></w:tbl>`,
          `<w:p><w:del><w:r><w:t>struck out</w:t></w:r></w:del><w:ins><w:r><w:t>written in</w:t></w:r></w:ins></w:p>`,
          "<w:p/>",
        ].join(""),
        { "word/styles.xml": styles, "word/numbering.xml": numbering },
      ),
    );
    expect(lines(blocksOf(content))).toEqual([
      "h1 Quarterly plan",
      "h2 Goals",
      "Plain, **bold**_ and leaning_",
      "1. Hire",
      "  a) Two people",
      "  b) One more",
      "2. Ship",
      "• Bullet by its style",
      "table Who|When / Ana|May",
      "written in",
    ]);
    const table = blocksOf(content).find((block) => block._tag === "table");
    expect(table?._tag === "table" && table.header).toBe(true);
  });

  it("shows a picture whose bytes are a PNG, and nothing for one that only says it is", () => {
    const drawing = (id: string) =>
      `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const content = read(
      "word",
      word(drawing("rId5") + drawing("rId6") + drawing("rId7"), {
        "word/_rels/document.xml.rels": `<Relationships>
          <Relationship Id="rId5" Type="image" Target="media/image1.png"/>
          <Relationship Id="rId6" Type="image" Target="media/image2.png"/>
          <Relationship Id="rId7" Type="image" Target="https://example.com/tracker.png" TargetMode="External"/>
        </Relationships>`,
        "word/media/image1.png": PNG,
        "word/media/image2.png":
          "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      }),
    );
    expect(lines(blocksOf(content))).toEqual(["image image/png"]);
  });

  it("says how many pages the file says it had", () => {
    const content = read(
      "word",
      word(p("Hi"), { "docProps/app.xml": "<Properties><Pages>12</Pages></Properties>" }),
    );
    expect(factsOf(content)).toEqual({ _tag: "pages", count: 12 });
  });

  it("refuses a part that declares entities, whatever it would expand to", () => {
    const bytes = zip({
      "word/document.xml": `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><w:document><w:body>${p("&b;")}</w:body></w:document>`,
    });
    expect(readDocument("word", bytes, "en")).toEqual({ _tag: "unreadable" });
  });

  it("reads a tag of any length in time, and refuses one that is no well-formed tag", () => {
    // A small file whose one tag runs on with no attribute value.
    const bytes = zip({
      "word/document.xml": `<w:document><w:body><w:p ${"a".repeat(200_000)}></w:p></w:body></w:document>`,
    });
    expect(bytes.length).toBeLessThan(10 * 1024);
    expect(readDocument("word", bytes, "en")).toEqual({ _tag: "unreadable" });
  });

  it("stops unpacking a part past the limit, however small the file", () => {
    const bomb = zip({ "word/document.xml": new Uint8Array(DOCUMENT_LIMITS.partBytes + 1) });
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(readDocument("word", bomb, "en")).toEqual({ _tag: "tooBig" });
  });

  it("finds nothing to read in a file protected by a password or saved before 2007", () => {
    // Both are an OLE compound file, not a zip.
    const compound = new Uint8Array(4096);
    compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(readDocument("word", compound, "en")).toEqual({ _tag: "unreadable" });
    expect(readDocument("sheet", compound, "en")).toEqual({ _tag: "unreadable" });
  });
});

describe("Excel workbooks", () => {
  const workbook = (
    sheets: Record<string, string>,
    extra: Record<string, string> = {},
    hidden: ReadonlyArray<string> = [],
  ) => {
    const names = Object.keys(sheets);
    return zip({
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<workbook><sheets>${names
        .map(
          (name, at) =>
            `<sheet name="${name}" sheetId="${at + 1}" r:id="rId${at + 1}"${hidden.includes(name) ? ' state="hidden"' : ""}/>`,
        )
        .join("")}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships>${names
        .map(
          (_, at) =>
            `<Relationship Id="rId${at + 1}" Type="worksheet" Target="worksheets/sheet${at + 1}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rS" Type="sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rT" Type="styles" Target="styles.xml"/></Relationships>`,
      ...Object.fromEntries(
        Object.values(sheets).map((data, at) => [
          `xl/worksheets/sheet${at + 1}.xml`,
          `<worksheet><sheetData>${data}</sheetData></worksheet>`,
        ]),
      ),
      ...extra,
    });
  };
  const sheetsOf = (content: DocumentContent) => {
    if (content._tag !== "sheets") throw new Error(`Expected sheets, got ${content._tag}.`);
    return content.sheets;
  };

  it("shows each visible sheet's cells where they are, as their formats say, in the reader's language", () => {
    const content = read(
      "sheet",
      workbook(
        {
          Budget: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
            <row r="3"><c r="A3" s="1"><v>45000</v></c><c r="B3" s="2"><v>0.125</v></c><c r="C3"><v>1234.5</v></c><c r="D3" t="inlineStr"><is><t>inline</t></is></c><c r="E3" t="b"><v>1</v></c><c r="F3" t="str"><f>A1</f><v>Rent</v></c></row>`,
          Secret: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
        },
        {
          "xl/sharedStrings.xml": `<sst><si><t>Rent</t></si><si><r><t>Total </t></r><r><t>due</t></r><rPh><t>reading</t></rPh></si></sst>`,
          "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="&quot;Due&quot; dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="10"/></cellXfs></styleSheet>`,
        },
        ["Secret"],
      ),
      "pt-BR",
    );
    expect(sheetsOf(content)).toEqual([
      {
        name: "Budget",
        columns: 6,
        cut: false,
        rows: [
          ["Rent", "", "Total due", "", "", ""],
          ["", "", "", "", "", ""],
          ["15/03/2023", "12,5%", "1234,5", "inline", "TRUE", "Rent"],
        ],
      },
    ]);
  });

  it("stops reading a sheet past the rows it shows, and says so", () => {
    const rows = Array.from(
      { length: DOCUMENT_LIMITS.rows + 500 },
      (_, at) => `<row r="${at + 1}"><c r="A${at + 1}"><v>${at}</v></c></row>`,
    ).join("");
    const [sheet] = sheetsOf(read("sheet", workbook({ Long: rows })));
    expect(sheet?.rows.length).toBe(DOCUMENT_LIMITS.rows);
    expect(sheet?.cut).toBe(true);
  });

  it("counts every row toward the limit, however the file numbers them", () => {
    const rows = `<row r="1"><c r="A1"><v>1</v></c></row>`.repeat(DOCUMENT_LIMITS.rows + 500);
    const [sheet] = sheetsOf(read("sheet", workbook({ Same: rows })));
    expect(sheet?.rows.length).toBe(DOCUMENT_LIMITS.rows);
    expect(sheet?.cut).toBe(true);
  });
});

describe("PowerPoint presentations", () => {
  it("reads slides in the presentation's order, skipping hidden ones, as their titles, bullets, numbers and pictures", () => {
    const slide = (body: string, attributes = "") =>
      `<p:sld${attributes}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
    const shape = (placeholder: string, paragraphs: string) =>
      `<p:sp><p:nvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs}</p:txBody></p:sp>`;
    const para = (text: string, properties = "") =>
      `<a:p>${properties}<a:r><a:t>${text}</a:t></a:r></a:p>`;
    const content = read(
      "slides",
      zip({
        "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="x/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
        "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/><p:sldId id="258" r:id="rC"/></p:sldIdLst></p:presentation>`,
        "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rA" Type="slide" Target="slides/slide1.xml"/><Relationship Id="rB" Type="slide" Target="slides/slide2.xml"/><Relationship Id="rC" Type="slide" Target="slides/slide3.xml"/></Relationships>`,
        "ppt/slides/slide2.xml": slide(
          shape('<p:ph type="ctrTitle"/>', para("Launch")) +
            shape('<p:ph type="subTitle" idx="1"/>', para("Spring 2026")),
        ),
        "ppt/slides/slide1.xml": slide(
          shape('<p:ph type="title"/>', para("Steps")) +
            shape(
              '<p:ph idx="1"/>',
              para("Plan") +
                para("Draft", '<a:pPr lvl="1"/>') +
                para("No bullet", "<a:pPr><a:buNone/></a:pPr>"),
            ) +
            shape(
              "",
              para("One", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
                para("Two", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
            ) +
            `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="A chart"/></p:nvPicPr><p:blipFill><a:blip r:embed="rP"/></p:blipFill></p:pic>`,
        ),
        "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rP" Type="image" Target="../media/image1.png"/></Relationships>`,
        "ppt/media/image1.png": PNG,
        "ppt/slides/slide3.xml": slide(shape('<p:ph type="title"/>', para("Hidden")), ' show="0"'),
      }),
    );
    if (content._tag !== "slides") throw new Error("Expected slides.");
    expect(content.slides.map((each) => [each.title, lines(each.blocks)])).toEqual([
      ["Launch", ["Spring 2026"]],
      ["Steps", ["• Plan", "  • Draft", "No bullet", "1. One", "2. Two", "image image/png"]],
    ]);
    expect(factsOf(content)).toEqual({ _tag: "slides", count: 2 });
  });
});

describe("CSV files", () => {
  const sheet = (content: DocumentContent) => {
    if (content._tag !== "sheets") throw new Error("Expected sheets.");
    return content.sheets[0];
  };

  it("finds the delimiter, and keeps quoted delimiters, quotes and line breaks in their field", () => {
    const text = 'name;note;amount\r\nAna;"says ""hi""; twice";1,5\r\nBruno;"two\nlines";2\r\n';
    expect(sheet(read("csv", strToU8(text)))?.rows).toEqual([
      ["name", "note", "amount"],
      ["Ana", 'says "hi"; twice', "1,5"],
      ["Bruno", "two\nlines", "2"],
    ]);
  });

  it("follows a sep= line, and reads a file saved in Windows-1252", () => {
    // "Ação,Preço" in Windows-1252: ç is E7, ã E3 and é E9, none of them UTF-8.
    const bytes = Uint8Array.from([
      ...strToU8("sep=|\n"),
      0x41,
      0xe7,
      0xe3,
      0x6f,
      0x2c,
      0x31,
      0x7c,
      0x50,
      0x72,
      0x65,
      0xe7,
      0x6f,
    ]);
    expect(sheet(read("csv", bytes))?.rows).toEqual([["Ação,1", "Preço"]]);
  });

  it("says how many rows it has", () => {
    expect(factsOf(read("csv", strToU8("a,b\n1,2\n3,4\n")))).toEqual({
      _tag: "rows",
      count: 3,
      more: false,
    });
  });
});

describe("Markdown files", () => {
  it("reads blocks and inline styles, and shows a link as its text and an image as its description", () => {
    const text = [
      "Title",
      "=====",
      "",
      "Some **bold**, *leaning*, `code` and snake_case_name, see [the guide](https://example.com/guide).",
      "![A cat](https://example.com/cat.png)",
      "",
      "- one",
      "  - nested",
      "- [x] done",
      "3. three",
      "",
      "> quoted",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 \\| 3 |",
      "",
      "```js",
      "let x = 1;",
      "```",
      "",
      "---",
      "<script>alert(1)</script>",
    ].join("\n");
    expect(lines(blocksOf(read("markdown", strToU8(text))))).toEqual([
      "h1 Title",
      "Some **bold**, _leaning_, `code` and snake_case_name, see the guide. A cat",
      "• one",
      "  ◦ nested",
      "☑ done",
      "3. three",
      "> quoted",
      "table a|b / 1|2 | 3",
      "code let x = 1;",
      "rule",
      "<script>alert(1)</script>",
    ]);
  });

  it("reads a paragraph full of marks that close nothing as its text, in time", () => {
    // Each would take minutes were every mark to look for its close through the rest.
    for (const text of [
      `${"[".repeat(200_000)}](`,
      "a *".repeat(70_000),
      "<http:".repeat(40_000),
    ]) {
      const [block] = blocksOf(read("markdown", strToU8(text)));
      expect(block?._tag === "paragraph" && block.runs.map((run) => run.text).join("")).toBe(
        text.trim(),
      );
    }
  });
});

describe("Text files", () => {
  it("reads UTF-16 with its mark, and refuses bytes that are no text", () => {
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x4f, 0x00, 0x69, 0x00]);
    expect(read("text", utf16)).toEqual({ _tag: "text", text: "Oi", cut: false });
    expect(
      readDocument("text", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00]), "en"),
    ).toEqual({ _tag: "unreadable" });
  });
});

describe("fileDetail", () => {
  const en = createI18n("en");
  const pt = createI18n("pt-BR");
  const file = (name: string, mediaType: string) => ({ name, mediaType, size: 18_000 });

  it("names a document's kind in words, and what it holds once read", () => {
    expect(fileDetail(file("a.pdf", "application/pdf"), en, { _tag: "pages", count: 12 })).toBe(
      "PDF, 12 pages",
    );
    expect(
      fileDetail(file("a.xlsx", "application/octet-stream"), pt, { _tag: "sheets", count: 1 }),
    ).toBe("Planilha, 1 aba");
    expect(fileDetail(file("a.docx", "application/zip"), en)).toBe("Word document · 18 kB");
    expect(
      fileDetail(file("a.csv", "text/csv"), en, { _tag: "rows", count: 2000, more: true }),
    ).toBe("Table, over 2,000 rows");
    expect(fileDetail(file("a.zip", "application/zip"), en)).toBe("ZIP · 18 kB");
  });
});
