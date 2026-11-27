// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/** Why a document is not shown: past what a device reads, or not what it says it is. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  reason: Schema.Literals(["tooBig", "unreadable"]),
}) {}

/** Whether a thrown value is a `Refused`. */
export const isRefused = Schema.is(Refused);

// Windows-1252's characters for 0x80 to 0x9F, where it differs from Latin-1;
// the five it leaves undefined read as the control characters Latin-1 has there.
const WINDOWS_1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const fromCodes = (codes: Uint16Array) => {
  let text = "";
  // In slices, so no call takes more arguments than an engine allows.
  for (let at = 0; at < codes.length; at += 8192) {
    text += String.fromCharCode(...codes.subarray(at, at + 8192));
  }
  return text;
};

const windows1252 = (bytes: Uint8Array) => {
  const codes = new Uint16Array(bytes.length);
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at] ?? 0;
    codes[at] = byte >= 0x80 && byte < 0xa0 ? (WINDOWS_1252[byte - 0x80] ?? byte) : byte;
  }
  return fromCodes(codes);
};

const utf16 = (bytes: Uint8Array, littleEndian: boolean) => {
  const codes = new Uint16Array(Math.floor(bytes.length / 2));
  for (let at = 0; at < codes.length; at++) {
    const one = bytes[at * 2] ?? 0;
    const other = bytes[at * 2 + 1] ?? 0;
    codes[at] = littleEndian ? one | (other << 8) : (one << 8) | other;
  }
  return fromCodes(codes);
};

/** Whether `bytes` hold U+FFFD written in UTF-8 (EF BF BD). */
const holdsReplacement = (bytes: Uint8Array) => {
  for (
    let at = bytes.indexOf(0xef);
    at >= 0 && at < bytes.length - 2;
    at = bytes.indexOf(0xef, at + 1)
  ) {
    if (bytes[at + 1] === 0xbf && bytes[at + 2] === 0xbd) return true;
  }
  return false;
};

/**
 * The text of a file of unknown encoding: UTF-16 when it starts with that
 * mark, UTF-8 when it reads as UTF-8, and otherwise Windows-1252, which
 * spreadsheets on Windows still save CSV files in. A UTF-8 mark is dropped.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), false);
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  const text = new TextDecoder().decode(body);
  // Bytes that are not UTF-8 read as U+FFFD; a file that wrote U+FFFD itself is still UTF-8.
  return text.includes("�") && !holdsReplacement(body) ? windows1252(body) : text;
}

/** Decodes the UTF-8 of an XML part. */
export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
