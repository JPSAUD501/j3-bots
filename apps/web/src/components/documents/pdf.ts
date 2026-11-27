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
  library ??= import("pdfjs-dist");
  return library;
};

/** How opening a PDF ended: open, with the way to close it and its worker, or unreadable. */
export type PdfOpened =
  | { readonly _tag: "opened"; readonly pdf: PDFDocumentProxy; readonly close: () => void }
  | { readonly _tag: "unreadable" };

/** The largest picture in a PDF drawn, in pixels; a larger one is left out. */
const MAX_IMAGE_PIXELS = 50_000_000;
/** How long a PDF may take to open before it counts as unreadable. */
const OPEN_TIMEOUT_MS = 30_000;

/**
 * Opens a PDF from a copy of its bytes (PDF.js takes the buffer it is given
 * for its worker), in a worker of its own: one the app starts and hands to
 * PDF.js, so PDF.js never parses on the page instead, as it does when it
 * cannot start one itself. A PDF that is protected by a password, that is
 * no PDF, or that takes too long to open is unreadable, and its worker ends.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfOpened> {
  const { getDocument, PDFWorker } = await pdfjs();
  const thread = new Worker(worker, { type: "module" });
  const port = PDFWorker.create({ port: thread });
  const task = getDocument({
    data: bytes.slice(),
    worker: port,
    BinaryDataFactory: BundledDecoders,
    useWorkerFetch: false,
    useSystemFonts: true,
    enableXfa: false,
    maxImageSize: MAX_IMAGE_PIXELS,
  });
  const close = () => {
    void task.destroy().finally(() => {
      port.destroy();
      thread.terminate();
    });
  };
  let timer: number | undefined;
  const failed = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    thread.addEventListener("error", () => resolve(null));
  });
  const pdf = await Promise.race([task.promise, failed]).catch(() => null);
  window.clearTimeout(timer);
  if (pdf === null) {
    close();
    return { _tag: "unreadable" };
  }
  return { _tag: "opened", pdf, close };
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
