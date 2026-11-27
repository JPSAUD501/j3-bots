# 0078: Documents open in a viewer of the app's own, read on the client

**Status:** Accepted.

## Context

Bots send documents as often as pictures: a report as a PDF, a table as a CSV or an Excel workbook, a letter as a Word document, a deck as a PowerPoint file, notes in Markdown. The operator sends them too. Before this change each was a file card with a name and a size. On the web, opening one downloaded it; on Android it went to whatever app took its type, or to the share sheet. To see what a bot had made, the operator left J3 Bots.

These files come from a bot's workspace or from anywhere the operator got them, so they are untrusted. Office files are zips of XML that can name external addresses, hold macros and be built to expand without end; PDFs hold scripts and forms; any of them can be malformed on purpose. A viewer that is careless with them is an attack surface on every paired device.

## Decision

**A document in a conversation opens in a viewer inside the app, beside the image viewer, with the same open and close. Everything is read on the client, by readers that produce one typed model the app draws with its own components; no file's markup, script, style or address is ever used. PDFs are drawn by a PDF renderer and nothing else of them runs.**

- **Which files.** `documentKind` (`client-runtime/documents`) decides from the media type, and from the name's extension when the type says nothing (an `application/octet-stream` or `application/zip` upload) or says plain text of a `.md` or `.csv` file: PDF; plain text (also `.log` and JSON, shown as text); Markdown; CSV and TSV; Excel (`.xlsx`); Word (`.docx`); PowerPoint (`.pptx`). The older binary formats (`.xls`, `.doc`, `.ppt`) and OpenDocument are not read: they open in another app as before. The server now names `.docx`, `.xlsx`, `.pptx` and `.tsv` files a bot sends by their media types.
- **How far each format goes.**
  - **PDF** is drawn page by page as the file lays it out: fonts, pictures and vector art. No text layer (so its text cannot be selected or searched in the app), no forms, no annotations' actions, no scripts, no attachments. At most 500 pages show.
  - **Text** shows as written, in a monospace face, up to a million characters. A UTF-16 file with its byte order mark reads; a file that is not UTF-8 reads as Windows-1252.
  - **Markdown** shows its headings, paragraphs, lists (task lists as ☐ and ☑), quotes, code, tables, rules, and bold, italic and code within a line. A link shows as its text, an image as its description: the viewer fetches nothing. Raw HTML in it shows as text.
  - **CSV and TSV** show as a grid with lettered columns and numbered rows. A TSV file is split at tabs; for a CSV file the separator is found from the file (comma, semicolon, tab or bar, or a `sep=` line).
  - **Excel** shows each visible sheet as a grid of cell values as Excel shows them: shared and inline strings, numbers and dates in the operator's language, in the number format the cell names where it is a built-in or simple one (decimals, thousands, percentages, zero padding, dates and times, and durations such as `[h]:mm:ss`), booleans, and a formula's last value. No formulas run, no styles, merged cells or charts, no hidden sheets. At most 2,000 rows and 100 columns a sheet, 50 sheets.
  - **Word** shows its text as headings, paragraphs, numbered and bulleted lists, tables and its pictures, with bold and italic. Not shown: page layout, columns, headers and footers, footnotes, comments, tracked deletions, fonts and colors, shapes other than pictures. Its page count comes from the file's own properties when Word wrote them.
  - **PowerPoint**, a should in the request, shows each slide in order as its title, its text with its bullets and numbering, its tables and its pictures, skipping hidden slides. Not a faithful render: no layout, theme, shapes or animations. Drawing slides as they look would need a layout engine for a format with no open renderer fit to bundle; the words and pictures are what an operator usually opens a deck for.
- **Its card.** A document of at most 8 MiB shows a preview in its card once it comes into view: the top of a PDF's first page, the first lines of a text, the first rows of a sheet, the start of a Word or Markdown document, a deck's first title and picture. Its kind and size are said in words ("PDF, 1.2 MB"), and, once read, what it holds ("PDF, 12 pages", "Spreadsheet, 3 sheets", "Table, 214 rows"). A larger document shows the plain card, and opens in the viewer as any other.
- **When it cannot show.** A file over a reader's limits says "This file is too big to show here" and one it cannot read says so, each with what to do: Save it (web) or Open in another app (Android). A document that shows only its start says so above it.
- **Where it is read.** On the web, every format but PDF is read in a worker of its own, which ends with its answer or after 30 seconds; the page decodes the answer with the model's schema. PDFs are drawn by pdf.js in a worker the page starts for each one. On Android, every format but PDF is read on the JavaScript thread, within the same limits; PDF pages are drawn by Android's own renderer in a separate, isolated process ([Security: documents](../architecture/security.md#documents)).
- **Android parity.** Every format renders in the app, as on the web, and the viewer's bar has a button that opens the file in another app, as the image viewer's does. A device without the native module (iOS, for now) opens a PDF in the system's viewer as before.

## Libraries

- **pdf.js** (`pdfjs-dist`, Apache-2.0, Mozilla), web only, loaded only when a PDF is opened or previewed. Its build has no `eval`; it is configured with scripting, XFA and fetching off and with no font, character map or color profile data from the network. Its JBIG2 and JPEG 2000 decoders ship as two WebAssembly files with the web client (BSD, PDFium's and OpenJPEG's), whose licenses the release's third-party notices now carry: the notices now take the license files beside each bundled file, not only at its package's root.
- **fflate** (MIT), for the deflate inside Office files, in the client runtime. The zip container around it, the XML reader and the Markdown and CSV readers are J3 Bots' own: each is small, and owning it is what lets it refuse what it should (a DTD, an entity, a ZIP64 or encrypted entry, a part that inflates past its limit) and type its output without a cast.
- **Android's `PdfRenderer`** (the platform's, on PDFium), on Android; nothing added to the app.

## Costs

- **No text selection in PDFs.** pdf.js's text layer is HTML positioned over the page from the file's text; leaving it out keeps the file's content out of the page's markup. Save still gives the file.
- **An approximate Word and PowerPoint.** The operator sees the content, not the layout. A document whose meaning is in its layout (a form, a poster) is better opened elsewhere, which the viewer offers.
- **Android reads on the JavaScript thread.** A large workbook can hold the app for a moment while it is read. The limits bound it; a worker runtime for the shared readers is left for when it is shown to matter.
- **The web bundle grows** by pdf.js (about 440 kB, 135 kB gzipped, and a 1.3 MB worker) and two decoders (325 kB), all loaded only when a PDF is.
- **Android's renderer is the device's.** How a PDF looks depends on the PDFium of the phone's Android version, and the isolated process is **Assumed** to work on every device the app supports: it was compiled, not run on a device, in this change.

## Rejected

- **Render documents on the server.** A converter on the server (LibreOffice, a headless browser) would draw Office files faithfully, at the price of a large, frequently attacked dependency parsing untrusted files next to the operator's data and credentials, and a server that does more than relay. The client is where the operator chose to look, and its sandbox holds nothing but the page.
- **Show Office files through their HTML** (mammoth, a docx-to-HTML library, or an `iframe` of converted markup). Even sanitized, markup from a file is the shape of the bugs a viewer must not have; a typed model drawn by the app's own components cannot carry a script or an address by construction.
- **SheetJS for Excel.** Its npm package is years behind its own releases, which ship from its CDN; it reads far more than this viewer needs; and it has had prototype-pollution and denial-of-service advisories. A sheet reader for the subset shown here is a few hundred lines.
- **A general Markdown library** (marked, markdown-it). Their token types end in an open, untyped case, which the app would have to cast; and they produce HTML, which the viewer does not want.
- **Open documents in the system's viewer on Android.** That is what the app did, and what the operator asked to stop doing: it leaves the app, depends on what the phone has installed, and on a phone with no Office app ends at the share sheet.
