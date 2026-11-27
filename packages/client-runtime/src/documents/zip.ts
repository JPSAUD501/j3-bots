// SPDX-License-Identifier: AGPL-3.0-or-later
import { Inflate } from "fflate";
import { DOCUMENT_LIMITS } from "./limits.ts";
import { decodeUtf8, isRefused, Refused } from "./text.ts";

/** A part of a zip, as its central directory lists it. */
interface Part {
  readonly method: number;
  readonly compressedSize: number;
  readonly header: number;
}

/** The parts of a zip, read on demand within the limits. */
export interface Zip {
  readonly has: (name: string) => boolean;
  /** A part's bytes; null when the zip has no such part. */
  readonly bytes: (name: string) => Uint8Array | null;
  /** A part's text, as UTF-8; null when the zip has no such part. */
  readonly text: (name: string) => string | null;
}

// Fed to the inflater a kilobyte at a time: DEFLATE grows a kilobyte to at
// most about a megabyte, so the limit is checked before much more is held.
const STEP = 1024;

const word = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const long = (bytes: Uint8Array, at: number) =>
  (word(bytes, at) | (word(bytes, at + 2) << 16)) >>> 0;

/** Where the end-of-central-directory record starts, searched back over a comment of any length. */
function endRecord(bytes: Uint8Array): number {
  const last = bytes.length - 22;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (long(bytes, at) === 0x06054b50) return at;
  }
  throw new Refused({ reason: "unreadable" });
}

const normalized = (name: string) => name.replace(/^\/+/, "").replaceAll("\\", "/");

/**
 * Opens a zip held in memory, as a Word, Excel or PowerPoint file is. Only
 * what a part's central directory entry says is trusted to find it; a part is
 * unpacked a kilobyte at a time and refused past `partBytes`, and all of them
 * together past `unpackedBytes`, whatever sizes the zip claims. A zip that is
 * encrypted, spans disks or needs ZIP64 is unreadable: these documents are none of those.
 */
export function openZip(bytes: Uint8Array): Zip {
  const end = endRecord(bytes);
  const count = word(bytes, end + 10);
  const directory = long(bytes, end + 16);
  if (word(bytes, end + 4) !== 0 || count === 0xffff || directory === 0xffffffff) {
    throw new Refused({ reason: "unreadable" });
  }
  if (count > DOCUMENT_LIMITS.parts) throw new Refused({ reason: "tooBig" });
  const parts = new Map<string, Part>();
  let at = directory;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || long(bytes, at) !== 0x02014b50)
      throw new Refused({ reason: "unreadable" });
    const flags = word(bytes, at + 8);
    const nameLength = word(bytes, at + 28);
    const name = normalized(decodeUtf8(bytes.subarray(at + 46, at + 46 + nameLength)));
    const part: Part = {
      method: word(bytes, at + 10),
      compressedSize: long(bytes, at + 20),
      header: long(bytes, at + 42),
    };
    // An encrypted part (bit 0) is never one of these documents'.
    if ((flags & 1) === 0 && !name.endsWith("/")) parts.set(name, part);
    at += 46 + nameLength + word(bytes, at + 30) + word(bytes, at + 32);
  }
  let unpacked = 0;
  const take = (size: number) => {
    unpacked += size;
    if (unpacked > DOCUMENT_LIMITS.unpackedBytes) throw new Refused({ reason: "tooBig" });
  };
  const read = (name: string): Uint8Array | null => {
    const part = parts.get(name);
    if (part === undefined) return null;
    const header = part.header;
    if (header + 30 > bytes.length || long(bytes, header) !== 0x04034b50) {
      throw new Refused({ reason: "unreadable" });
    }
    const start = header + 30 + word(bytes, header + 26) + word(bytes, header + 28);
    const stored = bytes.subarray(start, start + part.compressedSize);
    if (stored.length !== part.compressedSize) throw new Refused({ reason: "unreadable" });
    if (part.method === 0) {
      if (stored.length > DOCUMENT_LIMITS.partBytes) throw new Refused({ reason: "tooBig" });
      take(stored.length);
      return stored;
    }
    if (part.method !== 8) throw new Refused({ reason: "unreadable" });
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    const inflater = new Inflate((chunk) => {
      size += chunk.length;
      take(chunk.length);
      if (size > DOCUMENT_LIMITS.partBytes) throw new Refused({ reason: "tooBig" });
      chunks.push(chunk);
    });
    try {
      for (let from = 0; from < stored.length; from += STEP) {
        inflater.push(stored.subarray(from, from + STEP), from + STEP >= stored.length);
      }
      if (stored.length === 0) inflater.push(stored, true);
    } catch (error) {
      if (isRefused(error)) throw error;
      throw new Refused({ reason: "unreadable" });
    }
    const whole = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      whole.set(chunk, offset);
      offset += chunk.length;
    }
    return whole;
  };
  return {
    has: (name) => parts.has(normalized(name)),
    bytes: (name) => read(normalized(name)),
    text: (name) => {
      const part = read(normalized(name));
      return part === null ? null : decodeUtf8(part);
    },
  };
}

/**
 * Where a relationship's target is, from the folder of the part that names
 * it: `media/a.png` from `word/document.xml` is `word/media/a.png`, and
 * `/xl/sheet.xml` is from the zip's root. Null for an address outside the
 * zip, which a document never needs to draw.
 */
export function resolvePart(from: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return base.join("/");
}
