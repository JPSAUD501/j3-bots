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

/** The width and height a picture's header says it has, in pixels; null when it says nothing that reads. */
function pixelsOf(bytes: Uint8Array, type: DocumentImageType): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (at: number, size: 1 | 2 | 4, little = false): number | null => {
    if (at + size > bytes.length) return null;
    return size === 1
      ? view.getUint8(at)
      : size === 2
        ? view.getUint16(at, little)
        : view.getUint32(at, little);
  };
  const area = (width: number | null, height: number | null) =>
    width === null || height === null || width === 0 || height === 0 ? null : width * height;
  switch (type) {
    case "image/png":
      return area(read(16, 4), read(20, 4));
    case "image/gif":
      return area(read(6, 2, true), read(8, 2, true));
    case "image/webp": {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X") {
        const width = read(24, 2, true);
        const widthHigh = read(26, 1);
        const height = read(27, 2, true);
        const heightHigh = read(29, 1);
        if (width === null || widthHigh === null || height === null || heightHigh === null)
          return null;
        return area(width + widthHigh * 65_536 + 1, height + heightHigh * 65_536 + 1);
      }
      if (chunk === "VP8 ") {
        const width = read(26, 2, true);
        const height = read(28, 2, true);
        return area(
          width === null ? null : width & 0x3fff,
          height === null ? null : height & 0x3fff,
        );
      }
      if (chunk === "VP8L") {
        const bits = read(21, 4, true);
        return bits === null ? null : area((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      return null;
    }
    case "image/jpeg": {
      // The first frame header (SOF0 to SOF15, but for DHT, JPG and DAC), past the segments before it.
      let at = 2;
      while (at + 4 <= bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1] ?? 0;
        if (marker === 0xff) {
          at += 1;
          continue;
        }
        const length = read(at + 2, 2);
        if (length === null || length < 2) return null;
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return area(read(at + 7, 2), read(at + 5, 2));
        }
        at += 2 + length;
      }
      return null;
    }
  }
}

/**
 * The pictures a document shows, within the limits (`images`, `imageBytes`,
 * `imagesBytes`, `imagePixels`, `imagesPixels`): a part whose bytes are no
 * GIF, JPEG, PNG or WebP (an EMF, an SVG, a page) is no picture, nor one whose
 * size cannot be read from its header. Each time a picture shows it counts
 * again, as a device draws it again; one past the limits is left out.
 */
export function pictures(zip: Zip): (part: string) => DocumentImage | null {
  let count = 0;
  let bytesShown = 0;
  let pixelsShown = 0;
  const read = new Map<string, { readonly image: DocumentImage; readonly pixels: number } | null>();
  return (part) => {
    // Past the count, no picture is unpacked at all.
    if (count >= DOCUMENT_LIMITS.images) return null;
    let known = read.get(part);
    if (known === undefined) {
      const bytes = zip.bytes(part);
      const mediaType = bytes === null ? null : imageTypeOf(bytes);
      const pixels = bytes === null || mediaType === null ? null : pixelsOf(bytes, mediaType);
      known =
        bytes === null ||
        mediaType === null ||
        pixels === null ||
        bytes.length > DOCUMENT_LIMITS.imageBytes ||
        pixels > DOCUMENT_LIMITS.imagePixels
          ? null
          : { image: { mediaType, bytes: bytes.slice() }, pixels };
      read.set(part, known);
    }
    if (
      known === null ||
      bytesShown + known.image.bytes.length > DOCUMENT_LIMITS.imagesBytes ||
      pixelsShown + known.pixels > DOCUMENT_LIMITS.imagesPixels
    ) {
      return null;
    }
    count += 1;
    bytesShown += known.image.bytes.length;
    pixelsShown += known.pixels;
    return known.image;
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
