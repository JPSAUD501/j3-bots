// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether an image is animated: an APNG (an `acTL` chunk before the first
 * `IDAT`) or an animated WebP (the `VP8X` header's animation flag). A theme's
 * background never moves (decision 0104), and a browser plays either one as a
 * CSS background, so it is refused before it is kept. A JPEG never moves.
 */
export const isAnimated = (bytes: Uint8Array, mediaType: string): boolean => {
  if (mediaType === "image/png") return pngIsAnimated(bytes);
  if (mediaType === "image/webp") return webpIsAnimated(bytes);
  return false;
};

const chunkType = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

const PNG_SIGNATURE_LENGTH = 8;

function pngIsAnimated(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE_LENGTH;
  // Each chunk: its length, its type, its data, and a CRC.
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = chunkType(bytes, at + 4);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    at += 12 + length;
  }
  return false;
}

/** The `VP8X` header's flag that says the file holds an animation. */
const WEBP_ANIMATION_FLAG = 0x02;

function webpIsAnimated(bytes: Uint8Array): boolean {
  // RIFF, size, WEBP, then the first chunk: an extended file's is `VP8X`, with its flags after its size.
  return chunkType(bytes, 12) === "VP8X" && ((bytes[20] ?? 0) & WEBP_ANIMATION_FLAG) !== 0;
}
