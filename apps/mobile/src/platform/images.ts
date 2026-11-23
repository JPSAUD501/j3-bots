// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import type { Attachment, AttachmentId } from "@j3-bots/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";

/** The folder in the app's cache that holds the images files show, one file each, by its id. */
const folder = () => new Directory(Paths.cache, "images");

/** Each image this run has asked for, by its file: its file's address, or null when it cannot be had. */
const asked = new Map<AttachmentId, Promise<string | null>>();
/** Images written before the server was last forgotten belong to it: none is written after. */
let generation = 0;

const extensions: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * The address of a local copy of a file's image, for a chip, a card or the
 * viewer to draw: its bytes come through the runtime, with this device's
 * credential, once per run, and are kept in the app's cache, where the
 * system may clear them. Null for a file that does not show as an image
 * (`showsImage`), or whose bytes cannot be had.
 */
function imageFile(client: J3Client, attachment: Attachment): Promise<string | null> {
  if (!showsImage(attachment)) return Promise.resolve(null);
  const known = asked.get(attachment.id);
  if (known !== undefined) return known;
  const started = generation;
  const loaded = (async () => {
    const file = new File(
      folder(),
      `${attachment.id}.${extensions[attachment.mediaType] ?? "img"}`,
    );
    if (file.exists) return file.uri;
    const result = await client.download(attachment);
    if (result._tag === "failed" || started !== generation) return null;
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
    if (uri === null && asked.get(attachment.id) === loaded) asked.delete(attachment.id);
  });
  asked.set(attachment.id, loaded);
  return loaded;
}

/** A file's image as the app has it: being fetched, at a local address, or not to be had. */
export type ImageState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "shown"; readonly uri: string }
  | { readonly _tag: "failed" };

/** `attachment`'s image as `imageFile` has it; for a file that does not show as one, `failed`. */
export function useImageFile(client: J3Client, attachment: Attachment): ImageState {
  const [state, setState] = useState<{ readonly id: AttachmentId; readonly image: ImageState }>({
    id: attachment.id,
    image: { _tag: "loading" },
  });
  useEffect(() => {
    let current = true;
    void imageFile(client, attachment).then((uri) => {
      if (current) {
        setState({
          id: attachment.id,
          image: uri === null ? { _tag: "failed" } : { _tag: "shown", uri },
        });
      }
    });
    return () => {
      current = false;
    };
  }, [client, attachment]);
  if (!showsImage(attachment)) return { _tag: "failed" };
  return state.id === attachment.id ? state.image : { _tag: "loading" };
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
      void imageFile(client, attachment).then((uri) => {
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
