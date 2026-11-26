// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, WorkImageId } from "@j3-bots/contracts";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import { createContext, type ReactNode, use, useEffect, useEffectEvent, useState } from "react";

/** A file's image, as the page draws it: an address of its bytes in this page, or why there is none. */
export type ImageState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "shown"; readonly url: string }
  | { readonly _tag: "failed" };

/**
 * An image the page draws: a file's, which shows as an image only when its
 * type and size let it (`showsImage`), or one a step of a bot's work looked at.
 */
export type ImageSource =
  | { readonly _tag: "file"; readonly attachment: Attachment }
  | { readonly _tag: "work"; readonly id: WorkImageId };

const keyOf = (source: ImageSource) =>
  source._tag === "file" ? `file:${source.attachment.id}` : `work:${source.id}`;

/** Each image the page has drawn, by its source. */
interface ImageCache {
  readonly peek: (source: ImageSource) => string | undefined;
  readonly load: (source: ImageSource) => Promise<string | null>;
}

// The most images the page keeps in hand; the oldest one drawn goes first.
const KEPT = 64;

function imageCache(fetch: (source: ImageSource) => Promise<Blob | null>): ImageCache {
  const shown = new Map<string, string>();
  const loading = new Map<string, Promise<string | null>>();
  const keep = (key: string, url: string) => {
    shown.delete(key);
    shown.set(key, url);
    for (const [old, oldUrl] of shown) {
      if (shown.size <= KEPT) break;
      shown.delete(old);
      URL.revokeObjectURL(oldUrl);
    }
  };
  return {
    peek: (source) => {
      const key = keyOf(source);
      const url = shown.get(key);
      if (url !== undefined) keep(key, url);
      return url;
    },
    load: (source) => {
      const key = keyOf(source);
      const known = shown.get(key);
      if (known !== undefined) return Promise.resolve(known);
      const pending = loading.get(key);
      if (pending !== undefined) return pending;
      const next = fetch(source).then(
        (blob) => {
          loading.delete(key);
          if (blob === null) return null;
          const url = URL.createObjectURL(blob);
          keep(key, url);
          return url;
        },
        () => {
          loading.delete(key);
          return null;
        },
      );
      loading.set(key, next);
      return next;
    },
  };
}

const ImagesContext = createContext<ImageCache | null>(null);

/**
 * Draws images from their bytes, which `fetch` gets with this device's
 * credential: an image's address is never the server's, which would need the
 * credential in it. Without it, as in the gallery, no image shows.
 */
export function AttachmentImagesProvider({
  fetch,
  children,
}: {
  fetch: (source: ImageSource) => Promise<Blob | null>;
  children: ReactNode;
}) {
  const [cache] = useState(() => imageCache(fetch));
  return <ImagesContext value={cache}>{children}</ImagesContext>;
}

/** The image of `source`, or null when it shows none or nothing draws images here. */
export function useImage(source: ImageSource | null): ImageState | null {
  const cache = use(ImagesContext);
  const shows =
    cache !== null && source !== null && (source._tag === "work" || showsImage(source.attachment));
  const key = source === null ? null : keyOf(source);
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly image: ImageState;
  }>(() => {
    const url = shows && source !== null ? cache.peek(source) : undefined;
    return { key, image: url === undefined ? { _tag: "loading" } : { _tag: "shown", url } };
  });
  // A new source object with the same key is the same image: only a new key asks again.
  const sourceNow = useEffectEvent(() => source);
  useEffect(() => {
    const asked = sourceNow();
    if (!shows || asked === null) return;
    let current = true;
    void cache.load(asked).then((url) => {
      if (current) {
        setState({
          key,
          image: url === null ? { _tag: "failed" } : { _tag: "shown", url },
        });
      }
    });
    return () => {
      current = false;
    };
  }, [cache, shows, key]);
  if (!shows) return null;
  return state.key === key ? state.image : { _tag: "loading" };
}

/**
 * The image of `attachment`, when it shows as one (`showsImage`); null for a
 * file that does not, or when nothing draws images here.
 */
export function useAttachmentImage(attachment: Attachment | null): ImageState | null {
  return useImage(attachment === null ? null : { _tag: "file", attachment });
}
