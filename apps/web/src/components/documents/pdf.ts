// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import jbig2 from "pdfjs-dist/wasm/jbig2.wasm?url";
import openjpeg from "pdfjs-dist/wasm/openjpeg.wasm?url";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * PDF.js, loaded the first time a PDF shows, and set up for files nobody
 * vouches for (docs/architecture/security.md, "Documents"):
 *
 * - It parses in its own worker, and draws on a canvas: pixels, with no link,
 *   form, text layer or script of the file in the page. Its scripting (a
 *   separate sandbox build) is never loaded, nor XFA forms.
 * - Its build has no `eval`. It fetches only what it is pointed at, and it is
 *   pointed at nothing of the file: the decoders for JBIG2 and JPEG 2000
 *   images are the app's own files, handed over by `BundledDecoders`; it is
 *   given no fonts or character maps to fetch, so a font a PDF does not embed
 *   shows in a system font, and color profiles are left out.
 */

/** The app's copies of the decoders PDF.js asks for by name: nothing else is ever fetched. */
const DECODERS: Readonly<Record<string, string>> = {
  "jbig2.wasm": jbig2,
  "openjpeg.wasm": openjpeg,
};

/** What PDF.js asks for binary data (`BinaryDataFactory`): only the decoders above. */
class BundledDecoders {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === "wasmUrl" ? DECODERS[filename] : undefined;
    if (url === undefined) throw new Error(`No ${kind} data: ${filename}.`);
    // A file of the app's own build, at its own origin: no request of the server's API.
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The decoder ${filename} did not load.`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

let library: Promise<typeof import("pdfjs-dist")> | null = null;

const pdfjs = () => {
  library ??= import("pdfjs-dist").then((loaded) => {
    loaded.GlobalWorkerOptions.workerSrc = worker;
    return loaded;
  });
  return library;
};

/** How opening a PDF ended. */
export type PdfOpened =
  | { readonly _tag: "opened"; readonly pdf: PDFDocumentProxy }
  | { readonly _tag: "unreadable" };

/** The largest picture in a PDF drawn, in pixels; a larger one is left out. */
const MAX_IMAGE_PIXELS = 50_000_000;

/**
 * Opens a PDF from a copy of its bytes (PDF.js takes the buffer it is given
 * for its worker). One that is protected by a password, or that is no PDF, is
 * unreadable.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfOpened> {
  try {
    const { getDocument } = await pdfjs();
    const pdf = await getDocument({
      data: bytes.slice(),
      BinaryDataFactory: BundledDecoders,
      useWorkerFetch: false,
      useSystemFonts: true,
      enableXfa: false,
      maxImageSize: MAX_IMAGE_PIXELS,
    }).promise;
    return { _tag: "opened", pdf };
  } catch {
    return { _tag: "unreadable" };
  }
}

/** The most pixels a page is drawn with: a page of A4 at about 300 dots an inch. */
const MAX_PAGE_PIXELS = 9_000_000;

/**
 * Draws `page` on `canvas`, `width` CSS pixels wide, sharp on this screen
 * within `MAX_PAGE_PIXELS`. Resolves once drawn; `signal` cancels it.
 */
export async function drawPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  width: number,
  signal: AbortSignal,
): Promise<void> {
  const unit = page.getViewport({ scale: 1 });
  const fit = width / unit.width;
  const ratio = Math.min(
    window.devicePixelRatio,
    Math.sqrt(MAX_PAGE_PIXELS / (unit.width * fit * unit.height * fit)),
  );
  const viewport = page.getViewport({ scale: fit * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel);
  try {
    await task.promise;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** A page's height for each unit of its width, to hold its place before it is drawn. */
export const pageShape = (page: PDFPageProxy): number => {
  const unit = page.getViewport({ scale: 1 });
  return unit.height / unit.width;
};
