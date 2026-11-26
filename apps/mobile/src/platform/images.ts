// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import type { Attachment, AttachmentId, WorkImageId } from "@j3-bots/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useEffectEvent, useState } from "react";

/** The folder in the app's cache that holds the images files show, one file each, by its id. */
const folder = () => new Directory(Paths.cache, "images");

/**
 * An image the app draws: a file's, which shows as an image only when its
 * type and size let it (`showsImage`), or one a step of a bot's work looked at.
 */
export type ImageSource =
  | { readonly _tag: "file"; readonly attachment: Attachment }
  | { readonly _tag: "work"; readonly id: WorkImageId };

/** The name its copy is kept under, which also tells one source from another. */
const keyOf = (source: ImageSource) =>
  source._tag === "file" ? source.attachment.id : `work-${source.id}`;

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
 * The address of a local copy of an image, for a chip, a card, a step or the
 * viewer to draw: its bytes come through the runtime, with this device's
 * credential, once per run, and are kept in the app's cache, where the
 * system may clear them. Null for a file that does not show as an image
 * (`showsImage`), or an image whose bytes cannot be had. One a bot looked at
 * is fetched again in each run: the server reads it from the bot's workspace
 * as it is then.
 */
function imageFile(client: J3Client, source: ImageSource): Promise<string | null> {
  if (source._tag === "file" && !showsImage(source.attachment)) return Promise.resolve(null);
  const key = keyOf(source);
  const known = asked.get(key);
  if (known !== undefined) return known;
  const started = generation;
  const loaded = (async () => {
    if (source._tag === "file") {
      const kept = new File(folder(), `${key}.${extensions[source.attachment.mediaType] ?? "img"}`);
      if (kept.exists) return kept.uri;
    }
    const result =
      source._tag === "file"
        ? await client.download(source.attachment)
        : await client.workImage(source.id);
    if (result._tag === "failed" || started !== generation) return null;
    const extension = extensions[result.value.mediaType];
    // Only the image types the app draws without running anything are kept.
    if (source._tag === "work" && extension === undefined) return null;
    const file = new File(
      folder(),
      `${key}.${source._tag === "file" ? (extensions[source.attachment.mediaType] ?? "img") : extension}`,
    );
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
          key: keyOf(asking),
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
