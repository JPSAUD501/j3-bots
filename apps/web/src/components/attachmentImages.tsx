// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, AttachmentId } from "@j3-bots/contracts";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import { createContext, type ReactNode, use, useEffect, useState } from "react";

/** A file's image, as the page draws it: an address of its bytes in this page, or why there is none. */
export type ImageState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "shown"; readonly url: string }
  | { readonly _tag: "failed" };

/** Each image the page has drawn, by its file. */
interface ImageCache {
  readonly peek: (id: AttachmentId) => string | undefined;
  readonly load: (attachment: Attachment) => Promise<string | null>;
}

// The most images the page keeps in hand; the oldest one drawn goes first.
const KEPT = 64;

function imageCache(fetch: (attachment: Attachment) => Promise<Blob | null>): ImageCache {
  const shown = new Map<AttachmentId, string>();
  const loading = new Map<AttachmentId, Promise<string | null>>();
  const keep = (id: AttachmentId, url: string) => {
    shown.delete(id);
    shown.set(id, url);
    for (const [old, oldUrl] of shown) {
      if (shown.size <= KEPT) break;
      shown.delete(old);
      URL.revokeObjectURL(oldUrl);
    }
  };
  return {
    peek: (id) => {
      const url = shown.get(id);
      if (url !== undefined) keep(id, url);
      return url;
    },
    load: (attachment) => {
      const known = shown.get(attachment.id);
      if (known !== undefined) return Promise.resolve(known);
      const pending = loading.get(attachment.id);
      if (pending !== undefined) return pending;
      const next = fetch(attachment).then(
        (blob) => {
          loading.delete(attachment.id);
          if (blob === null) return null;
          const url = URL.createObjectURL(blob);
          keep(attachment.id, url);
          return url;
        },
        () => {
          loading.delete(attachment.id);
          return null;
        },
      );
      loading.set(attachment.id, next);
      return next;
    },
  };
}

const ImagesContext = createContext<ImageCache | null>(null);

/**
 * Draws the images of files from their bytes, which `fetch` gets with this
 * device's credential: an image's address is never the server's, which would
 * need the credential in it. Without it, as in the gallery, no file shows its image.
 */
export function AttachmentImagesProvider({
  fetch,
  children,
}: {
  fetch: (attachment: Attachment) => Promise<Blob | null>;
  children: ReactNode;
}) {
  const [cache] = useState(() => imageCache(fetch));
  return <ImagesContext value={cache}>{children}</ImagesContext>;
}

/**
 * The image of `attachment`, when it shows as one (`showsImage`); null for a
 * file that does not, or when nothing draws images here.
 */
export function useAttachmentImage(attachment: Attachment | null): ImageState | null {
  const cache = use(ImagesContext);
  const shows = cache !== null && attachment !== null && showsImage(attachment);
  const id = attachment?.id ?? null;
  const [state, setState] = useState<{
    readonly id: AttachmentId | null;
    readonly image: ImageState;
  }>(() => {
    const url = shows && id !== null ? cache.peek(id) : undefined;
    return { id, image: url === undefined ? { _tag: "loading" } : { _tag: "shown", url } };
  });
  useEffect(() => {
    if (!shows || attachment === null) return;
    let current = true;
    void cache.load(attachment).then((url) => {
      if (current) {
        setState({
          id: attachment.id,
          image: url === null ? { _tag: "failed" } : { _tag: "shown", url },
        });
      }
    });
    return () => {
      current = false;
    };
  }, [cache, shows, attachment]);
  if (!shows) return null;
  return state.id === id ? state.image : { _tag: "loading" };
}
