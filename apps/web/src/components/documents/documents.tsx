// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DOCUMENT_LIMITS,
  type DocumentContent,
  type DocumentFacts,
  documentKind,
  factsOf,
  type ReadKind,
} from "@j3-bots/client-runtime/documents";
import type { Attachment } from "@j3-bots/contracts";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createContext, type ReactNode, use, useEffect, useEffectEvent, useState } from "react";
import { openPdf } from "./pdf";
import { decodeRead, ReadRequest } from "./readRequest";

/** A document as the page has it. */
export type DocumentState =
  | { readonly _tag: "loading" }
  /** Its bytes could not be had: the server is out of reach, or the file is gone. */
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "tooBig" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "content"; readonly content: DocumentContent }
  | { readonly _tag: "pdf"; readonly pdf: PDFDocumentProxy };

/** What a document's card says it holds, once read. */
export const factsOfState = (state: DocumentState): DocumentFacts =>
  state._tag === "content"
    ? factsOf(state.content)
    : state._tag === "pdf"
      ? { _tag: "pages", count: state.pdf.numPages }
      : { _tag: "none" };

/** How long a document may take to read before it counts as unreadable. */
const READ_TIMEOUT_MS = 30_000;

/** Reads a document in a worker of its own, which ends with the answer. */
function readInWorker(kind: ReadKind, bytes: Uint8Array, locale: string): Promise<DocumentState> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./reader.worker.ts", import.meta.url), { type: "module" });
    const end = (state: DocumentState) => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve(state);
    };
    const timer = window.setTimeout(() => end({ _tag: "unreadable" }), READ_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const read = decodeRead(event.data);
      end(read._tag === "read" ? { _tag: "content", content: read.content } : read);
    });
    worker.addEventListener("error", () => end({ _tag: "unreadable" }));
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker is reached only by the page that made it, and takes no target
    worker.postMessage(ReadRequest.make(kind, bytes, locale));
  });
}

/** Each document the page has read, by its file. */
interface DocumentCache {
  readonly peek: (attachment: Attachment) => DocumentState | undefined;
  readonly load: (attachment: Attachment) => Promise<DocumentState>;
}

// The most documents the page keeps read; the oldest one shown goes first,
// and a PDF it lets go of is closed.
const KEPT = 8;

function documentCache(
  fetch: (attachment: Attachment) => Promise<Uint8Array | null>,
  locale: string,
): DocumentCache {
  const kept = new Map<string, DocumentState>();
  const loading = new Map<string, Promise<DocumentState>>();
  const keep = (key: string, state: DocumentState) => {
    kept.delete(key);
    kept.set(key, state);
    for (const [old, oldState] of kept) {
      if (kept.size <= KEPT) break;
      kept.delete(old);
      if (oldState._tag === "pdf") void oldState.pdf.loadingTask.destroy();
    }
  };
  const read = async (attachment: Attachment): Promise<DocumentState> => {
    const kind = documentKind(attachment);
    if (kind === null) return { _tag: "unreadable" };
    const bytes = await fetch(attachment).catch(() => null);
    if (bytes === null) return { _tag: "unreachable" };
    if (kind !== "pdf") return readInWorker(kind, bytes, locale);
    const opened = await openPdf(bytes);
    return opened._tag === "opened" ? { _tag: "pdf", pdf: opened.pdf } : opened;
  };
  return {
    peek: (attachment) => {
      const state = kept.get(attachment.id);
      if (state !== undefined) keep(attachment.id, state);
      return state;
    },
    load: (attachment) => {
      const known = kept.get(attachment.id);
      if (known !== undefined) return Promise.resolve(known);
      const pending = loading.get(attachment.id);
      if (pending !== undefined) return pending;
      const next = read(attachment).then((state) => {
        loading.delete(attachment.id);
        // One that could not be fetched is asked for again the next time it shows.
        if (state._tag !== "unreachable") keep(attachment.id, state);
        return state;
      });
      loading.set(attachment.id, next);
      return next;
    },
  };
}

const DocumentsContext = createContext<DocumentCache | null>(null);

/**
 * Reads the documents of the files under it, from bytes that `fetch` gets
 * with this device's credential, in `locale` for a spreadsheet's numbers and
 * dates. Without it, as in most of the gallery, no document is read.
 */
export function DocumentsProvider({
  fetch,
  locale,
  children,
}: {
  fetch: (attachment: Attachment) => Promise<Uint8Array | null>;
  locale: string;
  children: ReactNode;
}) {
  const [cache] = useState(() => documentCache(fetch, locale));
  return <DocumentsContext value={cache}>{children}</DocumentsContext>;
}

/**
 * The document of `attachment`, read once `wanted`; null while it is not
 * wanted, or when nothing reads documents here.
 */
export function useDocument(attachment: Attachment, wanted: boolean): DocumentState | null {
  const cache = use(DocumentsContext);
  const key = attachment.id;
  const [state, setState] = useState<{ readonly key: string; readonly document: DocumentState }>(
    () => ({
      key,
      document: cache?.peek(attachment) ?? { _tag: "loading" },
    }),
  );
  const attachmentNow = useEffectEvent(() => attachment);
  useEffect(() => {
    if (cache === null || !wanted) return;
    let current = true;
    void cache.load(attachmentNow()).then((document) => {
      if (current) setState({ key, document });
    });
    return () => {
      current = false;
    };
  }, [cache, wanted, key]);
  if (cache === null || !wanted) return null;
  return state.key === key ? state.document : { _tag: "loading" };
}

/** The pages of a PDF that show, and whether it has more. */
export const shownPages = (pdf: PDFDocumentProxy) => ({
  count: Math.min(pdf.numPages, DOCUMENT_LIMITS.pages),
  cut: pdf.numPages > DOCUMENT_LIMITS.pages,
});
