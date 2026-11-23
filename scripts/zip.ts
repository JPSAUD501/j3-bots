// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a build script run by plain Node, outside any Effect program.
//
// Reads named files out of a zip archive in memory, so a build can unpack
// Node's Windows release (a .zip) on any machine, with no `unzip` or `tar` on
// it. It reads what Node's zips use: entries stored or deflated, without
// encryption, in an archive under 4 GB (no ZIP64). Anything else is refused.
import * as NodeZlib from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const LONGEST_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x1;

/** Each file of `zip` named in `names`, by name, decompressed and checked against its CRC-32. */
export const readZipEntries = (
  zip: Uint8Array,
  names: ReadonlyArray<string>,
): ReadonlyMap<string, Uint8Array> => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = (offset: number, size: number) => {
    if (offset < 0 || offset + size > zip.byteLength) {
      throw new Error("The zip archive is truncated or damaged.");
    }
    return offset;
  };
  const u16 = (offset: number) => view.getUint16(at(offset, 2), true);
  const u32 = (offset: number) => view.getUint32(at(offset, 4), true);

  // The end record is the last thing in the archive, before a comment of up to 64 KB.
  let end = -1;
  const earliest = Math.max(0, zip.byteLength - END_RECORD_SIZE - LONGEST_COMMENT);
  for (let offset = zip.byteLength - END_RECORD_SIZE; offset >= earliest; offset--) {
    if (u32(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end === -1) throw new Error("The file is not a zip archive: it has no end record.");
  const count = u16(end + 10);
  const directory = u32(end + 16);
  if (count === 0xffff || directory === 0xffffffff) {
    throw new Error("The zip archive is a ZIP64 archive, which this reader does not read.");
  }

  const wanted = new Set(names);
  const found = new Map<string, Uint8Array>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let entry = directory;
  for (let index = 0; index < count; index++) {
    if (u32(entry) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("The zip archive's central directory is damaged.");
    }
    const flags = u16(entry + 8);
    const method = u16(entry + 10);
    const crc = u32(entry + 16);
    const compressedSize = u32(entry + 20);
    const size = u32(entry + 24);
    const nameLength = u16(entry + 28);
    const extraLength = u16(entry + 30);
    const commentLength = u16(entry + 32);
    const localHeader = u32(entry + 42);
    const nameStart = at(entry + 46, nameLength);
    const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLength));
    entry = nameStart + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;

    if ((flags & ENCRYPTED) !== 0) throw new Error(`${name} is encrypted in the zip archive.`);
    if (u32(localHeader) !== LOCAL_FILE_HEADER) {
      throw new Error(`The zip archive's header of ${name} is damaged.`);
    }
    // The local header's own lengths: its extra field may differ from the directory's.
    const dataStart = localHeader + 30 + u16(localHeader + 26) + u16(localHeader + 28);
    const compressed = zip.subarray(at(dataStart, compressedSize), dataStart + compressedSize);
    let data: Uint8Array;
    if (method === STORED) data = compressed;
    else if (method === DEFLATED) data = NodeZlib.inflateRawSync(compressed);
    else
      throw new Error(
        `${name} is compressed with method ${method}, which this reader does not read.`,
      );
    if (data.byteLength !== size || NodeZlib.crc32(data) !== crc) {
      throw new Error(`${name} in the zip archive does not match its recorded size and CRC-32.`);
    }
    found.set(name, data);
  }
  const missing = names.filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`The zip archive holds no ${missing.join(", ")}.`);
  return found;
};
