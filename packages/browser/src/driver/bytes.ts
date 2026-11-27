// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

const encoder = new TextEncoder();

/** How many bytes a JSON value takes as UTF-8 text. */
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * A picture's size in pixels, read from its header, or undefined when the
 * header cannot be read.
 */
export const imageSize = (
  format: "png" | "jpeg",
  base64: string,
): { readonly width: number; readonly height: number } | undefined => {
  // The size is in the first bytes of a PNG; a JPEG's may come after its metadata.
  const decoded = Base64.decode(format === "png" ? base64.slice(0, 32) : base64);
  if (Result.isFailure(decoded)) return undefined;
  const bytes = decoded.success;
  return format === "png" ? pngSize(bytes) : jpegSize(bytes);
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngSize = (bytes: Uint8Array) => {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const jpegSize = (bytes: Uint8Array) => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC), hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
};
