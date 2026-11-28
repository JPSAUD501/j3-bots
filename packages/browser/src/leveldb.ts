// SPDX-License-Identifier: AGPL-3.0-or-later

// The keys a LevelDB database holds, read from its files without opening it:
// its logs and its tables, as LevelDB's `doc/log_format.md` and
// `doc/table_format.md` describe them, with the tables' blocks compressed by
// Snappy (`format_description.txt` of Snappy). Only the keys: a profile's
// storage is read by the browser itself, and these say where to look for it.
// A key a log deleted is still given, and so is an older one a newer write
// replaced: the reader asks the browser of each, which knows what holds.

/** The bytes of one file, read from `at` on. */
interface Cursor {
  readonly bytes: Uint8Array;
  at: number;
}

const byteAt = (cursor: Cursor): number | undefined => {
  const byte = cursor.bytes[cursor.at];
  if (byte !== undefined) cursor.at += 1;
  return byte;
};

/** A little-endian unsigned integer of `size` bytes at `at`; none past the end. */
const fixed = (bytes: Uint8Array, at: number, size: number): number | undefined => {
  if (at < 0 || at + size > bytes.length) return undefined;
  let value = 0;
  for (let index = size - 1; index >= 0; index--) value = value * 256 + (bytes[at + index] ?? 0);
  return value;
};

/** A varint of up to 64 bits, which stays exact up to 2^53. */
const varint = (cursor: Cursor): number | undefined => {
  let value = 0;
  let factor = 1;
  for (let index = 0; index < 10; index++) {
    const byte = byteAt(cursor);
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return value;
    factor *= 128;
  }
  return undefined;
};

/** Bytes of `length` from the cursor on, moving it past them; none past the end. */
const take = (cursor: Cursor, length: number): Uint8Array | undefined => {
  if (cursor.at + length > cursor.bytes.length) return undefined;
  const taken = cursor.bytes.subarray(cursor.at, cursor.at + length);
  cursor.at += length;
  return taken;
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};

/** The most a Snappy block may say it holds: LevelDB's blocks are a few KiB. */
const MOST_SNAPPY_BYTES = 64 * 1024 * 1024;

/** `input`, a raw Snappy block, uncompressed; none when it is not one. */
export const snappyDecompress = (input: Uint8Array): Uint8Array | undefined => {
  const cursor: Cursor = { bytes: input, at: 0 };
  const length = varint(cursor);
  if (length === undefined || length > MOST_SNAPPY_BYTES) return undefined;
  const output = new Uint8Array(length);
  let written = 0;
  while (cursor.at < input.length) {
    const tag = byteAt(cursor);
    if (tag === undefined) return undefined;
    if ((tag & 3) === 0) {
      let size = (tag >> 2) + 1;
      if (size > 60) {
        const extra = fixed(input, cursor.at, size - 60);
        if (extra === undefined) return undefined;
        cursor.at += size - 60;
        size = extra + 1;
      }
      const literal = take(cursor, size);
      if (literal === undefined || written + size > length) return undefined;
      output.set(literal, written);
      written += size;
      continue;
    }
    let size: number;
    let offset: number | undefined;
    switch (tag & 3) {
      case 1: {
        size = ((tag >> 2) & 7) + 4;
        const low = byteAt(cursor);
        offset = low === undefined ? undefined : ((tag >> 5) << 8) | low;
        break;
      }
      case 2:
        size = (tag >> 2) + 1;
        offset = fixed(input, cursor.at, 2);
        cursor.at += 2;
        break;
      default:
        size = (tag >> 2) + 1;
        offset = fixed(input, cursor.at, 4);
        cursor.at += 4;
    }
    if (offset === undefined || offset === 0 || offset > written || written + size > length)
      return undefined;
    // A copy may reach into what it writes: copied a stretch of `offset` at a time.
    let left = size;
    while (left > 0) {
      const step = Math.min(offset, left);
      output.copyWithin(written, written - offset, written - offset + step);
      written += step;
      left -= step;
    }
  }
  return written === length ? output : undefined;
};

/** A block's place in a table. */
interface BlockHandle {
  readonly offset: number;
  readonly size: number;
}

const blockHandle = (cursor: Cursor): BlockHandle | undefined => {
  const offset = varint(cursor);
  const size = varint(cursor);
  return offset === undefined || size === undefined ? undefined : { offset, size };
};

/** The table's magic number, as its last eight bytes hold it. */
const TABLE_MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];
const FOOTER_BYTES = 48;
/** Each block's trailer: its compression, then its checksum. */
const TRAILER_BYTES = 5;

/** A block's contents, uncompressed; none when it does not read. */
const readBlock = (table: Uint8Array, handle: BlockHandle): Uint8Array | undefined => {
  const end = handle.offset + handle.size;
  if (end + TRAILER_BYTES > table.length) return undefined;
  const raw = table.subarray(handle.offset, end);
  switch (table[end]) {
    case 0:
      return raw;
    case 1:
      return snappyDecompress(raw);
    default:
      return undefined;
  }
};

/** A block's entries: each key whole, from the prefix it shares with the one before. */
const blockEntries = (
  block: Uint8Array,
): ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }> | undefined => {
  const restarts = fixed(block, block.length - 4, 4);
  if (restarts === undefined) return undefined;
  const limit = block.length - 4 - restarts * 4;
  if (limit < 0) return undefined;
  const cursor: Cursor = { bytes: block.subarray(0, limit), at: 0 };
  const entries: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
  let last: Uint8Array = new Uint8Array(0);
  while (cursor.at < limit) {
    const shared = varint(cursor);
    const unshared = varint(cursor);
    const valueSize = varint(cursor);
    if (shared === undefined || unshared === undefined || valueSize === undefined) return undefined;
    if (shared > last.length) return undefined;
    const rest = take(cursor, unshared);
    const value = take(cursor, valueSize);
    if (rest === undefined || value === undefined) return undefined;
    const key = concat([last.subarray(0, shared), rest]);
    entries.push({ key, value });
    last = key;
  }
  return entries;
};

/** What each table key ends with: its sequence number and kind. */
const INTERNAL_KEY_TRAILER = 8;

/**
 * The keys of a table (`.ldb`, or `.sst` before), as their writers gave
 * them; none when the file is not a table this reads, since then what it
 * holds is unknown.
 */
export const tableKeys = (table: Uint8Array): ReadonlyArray<Uint8Array> | undefined => {
  if (table.length < FOOTER_BYTES) return undefined;
  const footer = table.subarray(table.length - FOOTER_BYTES);
  if (TABLE_MAGIC.some((byte, index) => footer[FOOTER_BYTES - 8 + index] !== byte))
    return undefined;
  const cursor: Cursor = { bytes: footer, at: 0 };
  if (blockHandle(cursor) === undefined) return undefined;
  const index = blockHandle(cursor);
  if (index === undefined) return undefined;
  const indexBlock = readBlock(table, index);
  const indexEntries = indexBlock === undefined ? undefined : blockEntries(indexBlock);
  if (indexEntries === undefined) return undefined;
  const keys: Array<Uint8Array> = [];
  for (const entry of indexEntries) {
    const handle = blockHandle({ bytes: entry.value, at: 0 });
    const data = handle === undefined ? undefined : readBlock(table, handle);
    const entries = data === undefined ? undefined : blockEntries(data);
    if (entries === undefined) return undefined;
    for (const { key } of entries) {
      if (key.length < INTERNAL_KEY_TRAILER) return undefined;
      keys.push(key.subarray(0, key.length - INTERNAL_KEY_TRAILER));
    }
  }
  return keys;
};

const LOG_BLOCK_BYTES = 32 * 1024;
const LOG_HEADER_BYTES = 7;
const RECORD = { full: 1, first: 2, middle: 3, last: 4 } as const;
/** A write batch's sequence number and count, before its records. */
const BATCH_HEADER_BYTES = 12;

/** The keys of one write batch, as far as it reads. */
const batchKeys = (batch: Uint8Array, into: Array<Uint8Array>) => {
  const cursor: Cursor = { bytes: batch, at: BATCH_HEADER_BYTES };
  while (cursor.at < batch.length) {
    const kind = byteAt(cursor);
    const keySize = varint(cursor);
    const key = keySize === undefined ? undefined : take(cursor, keySize);
    if (key === undefined) return;
    into.push(key);
    if (kind === 1) {
      const valueSize = varint(cursor);
      if (valueSize === undefined || take(cursor, valueSize) === undefined) return;
    } else if (kind !== 0) return;
  }
};

/**
 * The keys a log (`.log`) wrote, set or deleted. A log ends where its
 * writer stopped, which may be inside a record: what is cut short there is
 * left out.
 */
export const logKeys = (log: Uint8Array): ReadonlyArray<Uint8Array> => {
  const keys: Array<Uint8Array> = [];
  let parts: Array<Uint8Array> = [];
  let at = 0;
  while (at + LOG_HEADER_BYTES <= log.length) {
    const left = LOG_BLOCK_BYTES - (at % LOG_BLOCK_BYTES);
    if (left < LOG_HEADER_BYTES) {
      at += left;
      continue;
    }
    const length = fixed(log, at + 4, 2);
    const type = log[at + 6];
    if (length === undefined || type === undefined) break;
    if (type === 0) {
      // Space the writer set aside and never wrote: the rest of the block.
      at += left;
      continue;
    }
    const start = at + LOG_HEADER_BYTES;
    if (length > left - LOG_HEADER_BYTES || start + length > log.length) break;
    const fragment = log.subarray(start, start + length);
    at = start + length;
    switch (type) {
      case RECORD.full:
        batchKeys(fragment, keys);
        parts = [];
        break;
      case RECORD.first:
        parts = [fragment];
        break;
      case RECORD.middle:
        if (parts.length > 0) parts.push(fragment);
        break;
      case RECORD.last:
        if (parts.length > 0) batchKeys(concat([...parts, fragment]), keys);
        parts = [];
        break;
      default:
        return keys;
    }
  }
  return keys;
};
