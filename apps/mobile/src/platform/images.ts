// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import type {
  Attachment,
  AttachmentId,
  ThemeBackground,
  ThemeId,
  WorkImageId,
} from "@j3-bots/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useEffectEvent, useState } from "react";

/** The folder in the app's cache that holds the images files show, one file each, by its id. */
const folder = () => new Directory(Paths.cache, "images");

/**
 * An image the app draws: a file's, which shows as an image only when its
 * type and size let it (`showsImage`), one a step of a bot's work looked at,
 * or the one a theme shows behind the conversation, at its revision.
 */
export type ImageSource =
  | { readonly _tag: "file"; readonly attachment: Attachment }
  | { readonly _tag: "work"; readonly id: WorkImageId }
  | { readonly _tag: "theme"; readonly id: ThemeId; readonly background: ThemeBackground };

/** The name its copy is kept under, which also tells one source from another. */
const keyOf = (source: ImageSource) => {
  switch (source._tag) {
    case "file":
      return source.attachment.id;
    case "work":
      return `work-${source.id}`;
    case "theme":
      // A revision is the server's word: only what a file name takes is kept of it.
      return `theme-${source.id}-${source.background.revision.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }
};

/** The type a source's copy is kept as, where it is known before its bytes arrive. */
const knownType = (source: ImageSource): string | null => {
  switch (source._tag) {
    case "file":
      return source.attachment.mediaType;
    case "theme":
      return source.background.mediaType;
    case "work":
      return null;
  }
};

/** The bytes of `source`, through the runtime. */
const fetchImage = (client: J3Client, source: ImageSource) => {
  switch (source._tag) {
    case "file":
      return client.download(source.attachment);
    case "work":
      return client.workImage(source.id);
    case "theme":
      return client.themes.background(source.id, source.background);
  }
};

/** Each image this run has asked for, by its source: its file's address, or null when it cannot be had. */
const asked = new Map<string, Promise<string | null>>();
/** Images written before the server was last forgotten belong to it: none is written after. */
let generation = 0;

const extensions: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * The address of a local copy of an image, for a chip, a card, a step, the
 * viewer or the conversation's backdrop to draw: its bytes come through the
 * runtime, with this device's credential, once per run, and are kept in the
 * app's cache, where the system may clear them. Null for a file that does not
 * show as an image (`showsImage`), or an image whose bytes cannot be had. One
 * a bot looked at is fetched again in each run: the server reads it from the
 * bot's workspace as it is then.
 */
function imageFile(client: J3Client, source: ImageSource): Promise<string | null> {
  if (source._tag === "file" && !showsImage(source.attachment)) return Promise.resolve(null);
  const key = keyOf(source);
  const known = asked.get(key);
  if (known !== undefined) return known;
  const started = generation;
  const loaded = (async () => {
    const type = knownType(source);
    if (type !== null) {
      const kept = new File(folder(), `${key}.${extensions[type] ?? "img"}`);
      if (kept.exists) return kept.uri;
    }
    const result = await fetchImage(client, source);
    if (result._tag === "failed" || started !== generation) return null;
    // Only the image types the app draws without running anything are kept.
    const extension =
      type === null ? extensions[result.value.mediaType] : (extensions[type] ?? "img");
    if (extension === undefined) return null;
    const file = new File(folder(), `${key}.${extension}`);
    try {
      folder().create({ intermediates: true, idempotent: true });
      file.create({ overwrite: true });
      await file.write(result.value.bytes);
      if (started !== generation) {
        file.delete();
        return null;
      }
      return file.uri;
    } catch {
      return null;
    }
  })();
  // One that failed is asked for again the next time it shows.
  void loaded.then((uri) => {
    if (uri === null && asked.get(key) === loaded) asked.delete(key);
  });
  asked.set(key, loaded);
  return loaded;
}

/** A file's image as the app has it: being fetched, at a local address, or not to be had. */
export type ImageState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "shown"; readonly uri: string }
  | { readonly _tag: "failed" };

/** `source`'s image as `imageFile` has it; for a file that does not show as one, `failed`. */
export function useImage(client: J3Client, source: ImageSource): ImageState {
  const key = keyOf(source);
  const [state, setState] = useState<{ readonly key: string; readonly image: ImageState }>({
    key,
    image: { _tag: "loading" },
  });
  // A new source object with the same key is the same image: only a new key asks again.
  const sourceNow = useEffectEvent(() => source);
  useEffect(() => {
    let current = true;
    const asking = sourceNow();
    void imageFile(client, asking).then((uri) => {
      if (current) {
        setState({
          key,
          image: uri === null ? { _tag: "failed" } : { _tag: "shown", uri },
        });
      }
    });
    return () => {
      current = false;
    };
  }, [client, key]);
  if (source._tag === "file" && !showsImage(source.attachment)) return { _tag: "failed" };
  return state.key === key ? state.image : { _tag: "loading" };
}

/** `attachment`'s image as `imageFile` has it; for a file that does not show as one, `failed`. */
export function useImageFile(client: J3Client, attachment: Attachment): ImageState {
  return useImage(client, { _tag: "file", attachment });
}

/** The addresses of the images of `attachments` that `imageFile` has, by file. */
export function useImageFiles(
  client: J3Client,
  attachments: ReadonlyArray<Attachment>,
): ReadonlyMap<AttachmentId, string> {
  const [shown, setShown] = useState<ReadonlyMap<AttachmentId, string>>(new Map());
  // Asking again for an image already had costs nothing: its address is kept.
  useEffect(() => {
    let current = true;
    for (const attachment of attachments) {
      void imageFile(client, { _tag: "file", attachment }).then((uri) => {
        if (!current || uri === null) return;
        setShown((held) =>
          held.get(attachment.id) === uri ? held : new Map(held).set(attachment.id, uri),
        );
      });
    }
    return () => {
      current = false;
    };
  }, [client, attachments]);
  return shown;
}

/**
 * Deletes every image the app kept, as its server is forgotten or changed,
 * and keeps one still being fetched from being written. One the cache cannot
 * delete is left to the system.
 */
export function forgetImages(): void {
  generation += 1;
  asked.clear();
  try {
    const images = folder();
    if (images.exists) images.delete();
  } catch {
    // The cache is the system's to clear.
  }
}
