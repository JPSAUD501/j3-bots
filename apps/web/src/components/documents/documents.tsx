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
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
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
  /** An open PDF, and the way to close it and its worker once nothing shows it. */
  | { readonly _tag: "pdf"; readonly pdf: PDFDocumentProxy; readonly close: () => void };

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
  /** Keeps a document read while something shows it; the answer lets it go. */
  readonly hold: (attachment: Attachment) => () => void;
  /**
   * Starts the cache's use; the answer ends it, closing every PDF it holds,
   * and any that opens after.
   */
  readonly use: () => () => void;
}

// The most documents the page keeps read that nothing shows; the one shown
// longest ago goes first, and a PDF it lets go of is closed. One shown stays.
const KEPT = 8;

function documentCache(
  fetch: (attachment: Attachment) => Promise<Uint8Array | null>,
  locale: string,
): DocumentCache {
  const kept = new Map<string, DocumentState>();
  const loading = new Map<string, Promise<DocumentState>>();
  const holds = new Map<string, number>();
  let used = false;
  const trim = () => {
    let over = kept.size - KEPT;
    for (const [key, state] of kept) {
      if (over <= 0) break;
      if ((holds.get(key) ?? 0) > 0) continue;
      kept.delete(key);
      over -= 1;
      if (state._tag === "pdf") state.close();
    }
  };
  const keep = (key: string, state: DocumentState) => {
    kept.delete(key);
    kept.set(key, state);
    trim();
  };
  const read = async (attachment: Attachment): Promise<DocumentState> => {
    const kind = documentKind(attachment);
    if (kind === null) return { _tag: "unreadable" };
    const bytes = await fetch(attachment).catch(() => null);
    if (bytes === null) return { _tag: "unreachable" };
    if (kind !== "pdf") return readInWorker(kind, bytes, locale);
    const opened = await openPdf(bytes);
    return opened._tag === "opened"
      ? { _tag: "pdf", pdf: opened.pdf, close: opened.close }
      : opened;
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
        if (!used) {
          if (state._tag === "pdf") state.close();
          return state;
        }
        // One that could not be fetched is asked for again the next time it shows.
        if (state._tag !== "unreachable") keep(attachment.id, state);
        return state;
      });
      loading.set(attachment.id, next);
      return next;
    },
    hold: (attachment) => {
      const key = attachment.id;
      holds.set(key, (holds.get(key) ?? 0) + 1);
      return () => {
        const left = (holds.get(key) ?? 1) - 1;
        if (left > 0) holds.set(key, left);
        else holds.delete(key);
        trim();
      };
    },
    use: () => {
      used = true;
      return () => {
        used = false;
        for (const state of kept.values()) if (state._tag === "pdf") state.close();
        kept.clear();
      };
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
  // The first `fetch`, as the image cache keeps it: it reads from the server
  // the provider is mounted for. A cache for each language, since a
  // spreadsheet's numbers are read in it.
  const [read] = useState(() => fetch);
  const cache = useMemo(() => documentCache(read, locale), [read, locale]);
  useEffect(() => cache.use(), [cache]);
  return <DocumentsContext value={cache}>{children}</DocumentsContext>;
}

/**
 * The document of `attachment`, read once `wanted`; null while it is not
 * wanted, or when nothing reads documents here.
 */
export function useDocument(attachment: Attachment, wanted: boolean): DocumentState | null {
  const cache = use(DocumentsContext);
  const key = attachment.id;
  // Read by this cache: one of another language may have closed it.
  const [state, setState] = useState<{
    readonly key: string;
    readonly cache: DocumentCache | null;
    readonly document: DocumentState;
  }>(() => ({
    key,
    cache,
    document: cache?.peek(attachment) ?? { _tag: "loading" },
  }));
  const attachmentNow = useEffectEvent(() => attachment);
  useEffect(() => {
    if (cache === null || !wanted) return;
    let current = true;
    const shown = attachmentNow();
    const release = cache.hold(shown);
    void cache.load(shown).then((document) => {
      if (current) setState({ key, cache, document });
    });
    return () => {
      current = false;
      release();
    };
  }, [cache, wanted, key]);
  if (cache === null || !wanted) return null;
  return state.key === key && state.cache === cache ? state.document : { _tag: "loading" };
}

/** The pages of a PDF that show, and whether it has more. */
export const shownPages = (pdf: PDFDocumentProxy) => ({
  count: Math.min(pdf.numPages, DOCUMENT_LIMITS.pages),
  cut: pdf.numPages > DOCUMENT_LIMITS.pages,
});
