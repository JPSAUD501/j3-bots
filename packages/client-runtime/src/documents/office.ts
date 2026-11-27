// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import type { DocumentImage, DocumentImageType, Run } from "./model.ts";
import { relationshipsOf, relationshipsPart } from "./xml.ts";
import { resolvePart, type Zip } from "./zip.ts";

/** What Word, Excel and PowerPoint files share: a main part, its relationships and pictures. */

/**
 * The main part of an Office file, as its package relationships name it, or
 * `fallback` where they name none.
 */
export function mainPart(zip: Zip, fallback: string): string {
  for (const relationship of relationshipsOf(zip.text("_rels/.rels")).values()) {
    if (relationship.type.endsWith("/officeDocument") && !relationship.external) {
      const part = resolvePart("", relationship.target);
      if (part !== null) return part;
    }
  }
  return fallback;
}

/** A part's relationships, each id with the part it points to inside the zip. */
export function linkedParts(zip: Zip, part: string): ReadonlyMap<string, string> {
  const linked = new Map<string, string>();
  for (const [id, relationship] of relationshipsOf(zip.text(relationshipsPart(part)))) {
    if (relationship.external) continue;
    const target = resolvePart(part, safeDecode(relationship.target));
    if (target !== null) linked.set(id, target);
  }
  return linked;
}

const safeDecode = (target: string) => {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
};

/** The picture type `bytes` start as, whatever their name says; null for any other. */
function imageTypeOf(bytes: Uint8Array): DocumentImageType | null {
  const starts = (...prefix: ReadonlyArray<number>) =>
    prefix.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * The pictures a document shows, within `images` and `imagesBytes`: a part
 * whose bytes are no GIF, JPEG, PNG or WebP (an EMF, an SVG, a page) is no
 * picture, and one past the limits is left out.
 */
export function pictures(zip: Zip): (part: string) => DocumentImage | null {
  let count = 0;
  let total = 0;
  const seen = new Map<string, DocumentImage | null>();
  return (part) => {
    const known = seen.get(part);
    if (known !== undefined) return known;
    if (count >= DOCUMENT_LIMITS.images) return null;
    const bytes = zip.bytes(part);
    const mediaType = bytes === null ? null : imageTypeOf(bytes);
    const fits =
      bytes !== null &&
      bytes.length <= DOCUMENT_LIMITS.imageBytes &&
      total + bytes.length <= DOCUMENT_LIMITS.imagesBytes;
    const image =
      bytes !== null && mediaType !== null && fits ? { mediaType, bytes: bytes.slice() } : null;
    if (image !== null) {
      count += 1;
      total += image.bytes.length;
    }
    seen.set(part, image);
    return image;
  };
}

/** Whether a run property such as `w:b` or `a:b` is on: present and not "0", "false" or "off". */
export const switchedOn = (value: string | undefined): boolean =>
  value === undefined || !["0", "false", "off"].includes(value);

/** Adds `text` in `style` to `runs`, joining it to the last run when they share a style. */
export function addRun(runs: Array<Run>, text: string, style: Omit<Run, "text">): void {
  if (text === "") return;
  const last = runs.at(-1);
  if (
    last !== undefined &&
    last.bold === style.bold &&
    last.italic === style.italic &&
    last.code === style.code
  ) {
    runs[runs.length - 1] = { ...last, text: last.text + text };
  } else {
    runs.push({ text, ...style });
  }
}

/** The plain text of a list of runs. */
export const plainText = (runs: ReadonlyArray<Run>): string => runs.map((run) => run.text).join("");

/** Cuts `text` to `limit` characters, with an ellipsis where it was cut. */
export const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
