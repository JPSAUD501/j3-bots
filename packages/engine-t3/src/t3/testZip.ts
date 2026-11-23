// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A zip for a test is deflated and checksummed with node:zlib.
import * as NodeZlib from "node:zlib";

/** One entry of a zip written for a test. A name ending in `/` is a folder. */
export interface TestZipEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  readonly method?: "stored" | "deflated";
  /** A Unix mode, kept in the external attributes as Unix tools keep it. */
  readonly unixMode?: number;
  /** A CRC-32 other than the data's, to make a damaged archive. */
  readonly crc32?: number;
}

const u16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};
const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
};

/** A zip archive holding `entries`, in order, with UTF-8 names and no comment. */
export const makeZip = (entries: ReadonlyArray<TestZipEntry>): Uint8Array => {
  const encoder = new TextEncoder();
  const local: Array<Uint8Array> = [];
  const central: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    const deflated = entry.method === "deflated";
    const stored = deflated ? new Uint8Array(NodeZlib.deflateRawSync(raw)) : raw;
    const crc = entry.crc32 ?? NodeZlib.crc32(raw);
    const method = deflated ? 8 : 0;
    const header = [
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(stored.byteLength),
      u32(raw.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      stored,
    ];
    const madeBy = entry.unixMode === undefined ? 20 : (3 << 8) | 20;
    central.push(
      u32(0x02014b50),
      u16(madeBy),
      u16(20),
      u16(0x800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(stored.byteLength),
      u32(raw.byteLength),
      u16(name.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(entry.unixMode === undefined ? 0 : entry.unixMode << 16),
      u32(offset),
      name,
    );
    for (const part of header) {
      local.push(part);
      offset += part.byteLength;
    }
  }
  const directorySize = central.reduce((size, part) => size + part.byteLength, 0);
  const end = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directorySize),
    u32(offset),
    u16(0),
  ];
  const parts = [...local, ...central, ...end];
  const archive = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.byteLength;
  }
  return archive;
};
