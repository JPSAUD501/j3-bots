// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import {
  DOCUMENT_LIMITS,
  type DocumentContent,
  type DocumentFacts,
  documentKind,
  factsOf,
  readDocument,
} from "@j3-bots/client-runtime/documents";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { Attachment } from "@j3-bots/contracts";
import { requireOptionalNativeModule } from "expo";
import { Directory, File } from "expo-file-system";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useState } from "react";
import { useI18n } from "../i18n.ts";

// The app's own module (modules/document-pages), on Android only: it draws a
// PDF's pages with Android's renderer, in a process Android isolates. What it
// answers crosses from Kotlin, so each answer is decoded before the app
// trusts it.

interface DocumentPagesModule {
  folder(): string;
  shape(uri: string, most: number): Promise<unknown>;
  draw(uri: string, index: number, width: number): Promise<unknown>;
}

const native = requireOptionalNativeModule<DocumentPagesModule>("DocumentPages");

/** Whether this phone draws PDFs in the app; without it, a PDF opens in the system's viewer. */
export const drawsPdfs = native !== null;

const PageSize = Schema.Struct({ width: Schema.Int, height: Schema.Int });
export type PageSize = typeof PageSize.Type;

const PdfShape = Schema.NullOr(Schema.Struct({ count: Schema.Int, pages: Schema.Array(PageSize) }));
const decodeShape = Schema.decodeUnknownOption(PdfShape);
const decodeDrawing = Schema.decodeUnknownOption(Schema.NullOr(Schema.String));

/** A document as the app has it. */
export type DocumentState =
  | { readonly _tag: "loading" }
  /** Its bytes could not be had: the server is out of reach, or the file is gone. */
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "tooBig" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "content"; readonly content: DocumentContent }
  /** A PDF in the document folder, its page count and the sizes of the pages that show, in points. */
  | {
      readonly _tag: "pdf";
      readonly uri: string;
      readonly count: number;
      readonly pages: ReadonlyArray<PageSize>;
    };

/** What a document's card says it holds, once read. */
export const factsOfState = (state: DocumentState): DocumentFacts =>
  state._tag === "content"
    ? factsOf(state.content)
    : state._tag === "pdf"
      ? { _tag: "pages", count: state.count }
      : { _tag: "none" };

// The tallest a page shows, as a multiple of the width it has: a taller one
// shows narrower, whole.
const TALLEST = 20;

/** The box a page of `size` shows in, at most `width` wide: its own shape, whole. */
export function pageBox(
  size: PageSize,
  width: number,
): { readonly width: number; readonly height: number } {
  const tallness = Math.max(size.height, 1) / Math.max(size.width, 1);
  const height = Math.round(width * Math.min(tallness, TALLEST));
  return { width: Math.round(height / tallness), height };
}

/** Whether a PDF has more pages than show. */
export const pdfIsCut = (state: { readonly count: number }) => state.count > DOCUMENT_LIMITS.pages;

/** The folder in the app's cache that holds the PDFs drawn, and their pages' drawings. */
const folder = () => (native === null ? null : new Directory(native.folder()));

/** Each document this run has read, the last shown last, by its file and the language it was read in. */
const kept = new Map<string, { readonly id: string; readonly state: Promise<DocumentState> }>();
/** How many cards and viewers show each document now: one shown is kept. */
const holds = new Map<string, number>();
// The most documents kept read that nothing shows; the one shown longest ago
// goes first, and the PDF it wrote to the folder with it.
const KEPT = 8;
/** Documents read before the server was last forgotten belong to it: none is kept after. */
let generation = 0;
/** Whether this run cleared what a previous run left in the folder. */
let cleared = false;

/** A name for a file's PDF in the folder, of the characters any file system takes. */
const pdfName = (attachment: Attachment) => `${attachment.id.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;

async function read(
  client: J3Client,
  attachment: Attachment,
  locale: string,
  started: number,
): Promise<DocumentState> {
  const kind = documentKind(attachment);
  if (kind === null) return { _tag: "unreadable" };
  const result = await client.download(attachment);
  if (result._tag === "failed" || started !== generation) return { _tag: "unreachable" };
  const { bytes } = result.value;
  if (kind !== "pdf") {
    const read = readDocument(kind, bytes, locale);
    return read._tag === "read" ? { _tag: "content", content: read.content } : read;
  }
  const root = folder();
  if (native === null || root === null) return { _tag: "unreadable" };
  try {
    root.create({ intermediates: true, idempotent: true });
    const file = new File(root, pdfName(attachment));
    file.create({ overwrite: true });
    await file.write(bytes);
    if (started !== generation) {
      file.delete();
      return { _tag: "unreachable" };
    }
    const shape = decodeShape(await native.shape(file.uri, DOCUMENT_LIMITS.pages));
    if (shape._tag === "None" || shape.value === null || shape.value.count === 0) {
      return { _tag: "unreadable" };
    }
    return { _tag: "pdf", uri: file.uri, count: shape.value.count, pages: shape.value.pages };
  } catch {
    return { _tag: "unreadable" };
  }
}

/**
 * `attachment`'s document: its bytes come through the runtime, with this
 * device's credential, and are read on the phone. A PDF is written to the
 * app's cache for Android's renderer; any other kind is read into the shared
 * model (`readDocument`), within its limits. The documents of this run are
 * kept, a few at a time, so a card and its viewer read a document once.
 */
function documentOf(client: J3Client, attachment: Attachment, locale: string) {
  if (!cleared) {
    cleared = true;
    forgetFolder();
  }
  const key = `${locale}:${attachment.id}`;
  const known = kept.get(key);
  if (known !== undefined) {
    kept.delete(key);
    kept.set(key, known);
    return known.state;
  }
  const loaded = read(client, attachment, locale, generation);
  // One that could not be had is asked for again the next time it shows.
  void loaded.then((state) => {
    if (state._tag === "unreachable" && kept.get(key)?.state === loaded) kept.delete(key);
  });
  kept.set(key, { id: attachment.id, state: loaded });
  trim();
  return loaded;
}

/** Lets go of the documents past `KEPT` that nothing shows, the one shown longest ago first. */
function trim() {
  let over = kept.size - KEPT;
  for (const [key, old] of kept) {
    if (over <= 0) break;
    if ((holds.get(key) ?? 0) > 0) continue;
    kept.delete(key);
    over -= 1;
    void old.state.then((state) => {
      // Unless the file is read again meanwhile, in this language or another: its PDF is the same file.
      if (state._tag !== "pdf" || [...kept.values()].some(({ id }) => id === old.id)) return;
      try {
        new File(state.uri).delete();
      } catch {
        // Gone already, with the folder.
      }
    });
  }
}

/** Keeps the document of `key` while something shows it; the answer lets it go. */
function hold(key: string): () => void {
  holds.set(key, (holds.get(key) ?? 0) + 1);
  return () => {
    const left = (holds.get(key) ?? 1) - 1;
    if (left > 0) holds.set(key, left);
    else holds.delete(key);
    trim();
  };
}

/**
 * The document of `attachment`, read once `wanted`; null while it is not
 * wanted.
 */
export function useDocument(attachment: Attachment, wanted: boolean): DocumentState | null {
  const client = useJ3Client();
  const { locale } = useI18n();
  const key = `${locale}:${attachment.id}`;
  const [state, setState] = useState<{ readonly key: string; readonly document: DocumentState }>({
    key,
    document: { _tag: "loading" },
  });
  const attachmentNow = useEffectEvent(() => attachment);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    const release = hold(key);
    void documentOf(client, attachmentNow(), locale).then((document) => {
      if (current) setState({ key, document });
    });
    return () => {
      current = false;
      release();
    };
  }, [client, locale, wanted, key]);
  if (!wanted) return null;
  return state.key === key ? state.document : { _tag: "loading" };
}

/** A page's drawing as the app has it: being drawn, at a local address, or not to be had. */
export type PageDrawing =
  | { readonly _tag: "drawing" }
  | { readonly _tag: "drawn"; readonly uri: string }
  | { readonly _tag: "failed" };

/**
 * Page `index` (from 0) of the PDF at `uri`, drawn `width` pixels wide, once
 * `wanted`. Android keeps each drawing in the cache, so a page drawn once
 * shows again at once.
 */
export function usePdfPage(
  uri: string,
  index: number,
  width: number,
  wanted: boolean,
): PageDrawing {
  const key = `${uri}:${index}:${width}`;
  const [state, setState] = useState<{ readonly key: string; readonly page: PageDrawing }>({
    key,
    page: { _tag: "drawing" },
  });
  useEffect(() => {
    if (!wanted || native === null || width <= 0) return;
    let current = true;
    void native
      .draw(uri, index, width)
      .then((answer) => {
        const drawn = decodeDrawing(answer);
        return drawn._tag === "Some" && drawn.value !== null ? drawn.value : null;
      })
      .catch(() => null)
      .then((drawing) => {
        if (current) {
          setState({
            key,
            page: drawing === null ? { _tag: "failed" } : { _tag: "drawn", uri: drawing },
          });
        }
      });
    return () => {
      current = false;
    };
  }, [uri, index, width, wanted, key]);
  return state.key === key ? state.page : { _tag: "drawing" };
}

/**
 * Deletes every document the app read, as its server is forgotten or
 * changed, and keeps one still being read from being kept. What the cache
 * cannot delete is left to the system.
 */
export function forgetDocuments(): void {
  generation += 1;
  kept.clear();
  forgetFolder();
}

function forgetFolder() {
  try {
    const root = folder();
    if (root?.exists) root.delete();
  } catch {
    // The cache is the system's to clear.
  }
}
