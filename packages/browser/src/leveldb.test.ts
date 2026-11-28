// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { logKeys, snappyDecompress, tableKeys } from "./leveldb.ts";

// Files built by hand, byte by byte, as LevelDB and Snappy lay them out.

const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number> | Uint8Array>) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string" ? [...Buffer.from(part, "latin1")] : [...part],
    ),
  );
const text = (key: Uint8Array) => Buffer.from(key).toString("latin1");

const varint = (value: number): ReadonlyArray<number> => {
  const out: Array<number> = [];
  let left = value;
  while (left >= 0x80) {
    out.push((left % 0x80) | 0x80);
    left = Math.floor(left / 0x80);
  }
  out.push(left);
  return out;
};
const u16 = (value: number) => [value & 0xff, value >> 8];
const u32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  value >>> 24,
];

describe("Snappy", () => {
  it("expands a literal and a copy that reaches into what it writes", () => {
    // "abc", then 8 bytes copied from 3 back: the copy repeats what it writes.
    const block = bytes(varint(11), [(3 - 1) << 2], "abc", [((8 - 4) << 2) | 1, 3]);
    assert.strictEqual(text(snappyDecompress(block) ?? new Uint8Array()), "abcabcabcab");
  });

  it("refuses a copy from before the start, and a length it does not reach", () => {
    assert.isUndefined(
      snappyDecompress(bytes(varint(6), [(1 - 1) << 2], "a", [((5 - 4) << 2) | 1, 2])),
    );
    assert.isUndefined(snappyDecompress(bytes(varint(9), [(3 - 1) << 2], "abc")));
  });
});

/** A write batch of its records, sequence and count first. */
const batch = (...records: ReadonlyArray<ReadonlyArray<number>>) =>
  bytes(new Array<number>(8).fill(0), u32(records.length), ...records);
const put = (key: string, value: string) => [
  1,
  ...varint(key.length),
  ...Buffer.from(key, "latin1"),
  ...varint(value.length),
  ...Buffer.from(value, "latin1"),
];
const remove = (key: string) => [0, ...varint(key.length), ...Buffer.from(key, "latin1")];
/** One log record: a checksum it is not checked by, its length and its type. */
const record = (type: number, payload: Uint8Array) =>
  bytes([0, 0, 0, 0], u16(payload.length), [type], payload);

describe("a LevelDB log", () => {
  it("gives the keys it set and deleted, and leaves out a record cut short", () => {
    const log = bytes(
      record(
        1,
        batch(put("_https://a.test\u0000\u0001k", "\u0001v"), remove("META:https://b.test")),
      ),
      // Cut short where the writer stopped: its header promises more than follows.
      [0, 0, 0, 0],
      u16(50),
      [1],
      "partial",
    );
    assert.deepStrictEqual(logKeys(log).map(text), [
      "_https://a.test\u0000\u0001k",
      "META:https://b.test",
    ]);
  });

  it("joins a record split across blocks of 32 KiB", () => {
    const whole = batch(put("META:https://big.test", "x".repeat(40_000)));
    // The first part fills its block to the end, header included.
    const first = whole.subarray(0, 32 * 1024 - 7);
    const log = bytes(record(2, first), record(4, whole.subarray(first.length)));
    assert.deepStrictEqual(logKeys(log).map(text), ["META:https://big.test"]);
  });
});

/** A block of entries, each key sharing what it can with the one before, and one restart. */
const block = (keys: ReadonlyArray<string>, values: ReadonlyArray<Uint8Array>) => {
  const out: Array<number> = [];
  let last = "";
  keys.forEach((key, index) => {
    let shared = 0;
    while (shared < Math.min(key.length, last.length) && key[shared] === last[shared]) shared++;
    const value = values[index] ?? new Uint8Array();
    out.push(...varint(shared), ...varint(key.length - shared), ...varint(value.length));
    out.push(...Buffer.from(key.slice(shared), "latin1"), ...value);
    last = key;
  });
  return bytes(out, u32(0), u32(1));
};
/** A user key as a table keeps it: its sequence number and kind after it. */
const internal = (key: string) => `${key}\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u0000`;
/** `raw` as one Snappy literal. */
const snappy = (raw: Uint8Array) => bytes(varint(raw.length), [60 << 2, raw.length - 1], raw);

/** A table of one data block, compressed as `compression` says, and its index. */
const table = (keys: ReadonlyArray<string>, compression: number) => {
  const data = block(keys.map(internal), []);
  const stored = compression === 1 ? snappy(data) : data;
  const dataPart = bytes(stored, [compression], [0, 0, 0, 0]);
  const index = block([internal("~")], [bytes(varint(0), varint(stored.length))]);
  const indexPart = bytes(index, [0], [0, 0, 0, 0]);
  const footer = bytes(varint(0), varint(0), varint(dataPart.length), varint(index.length));
  return bytes(
    dataPart,
    indexPart,
    footer,
    new Array<number>(40 - footer.length).fill(0),
    [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb],
  );
};

describe("a LevelDB table", () => {
  const keys = ["META:https://a.test", "META:https://ab.test", "_https://a.test\u0000\u0001k"];

  it("gives its keys whole, from a block compressed with Snappy and prefixes shared", () => {
    assert.deepStrictEqual(tableKeys(table(keys, 1))?.map(text), keys);
  });

  it("refuses a block compressed another way, and a file that is not a table", () => {
    assert.isUndefined(tableKeys(table(keys, 2)));
    assert.isUndefined(tableKeys(bytes("not a table at all, nor long enough for a footer")));
  });
});
