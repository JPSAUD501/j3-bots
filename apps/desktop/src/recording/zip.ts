// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";

// A recording's zip, never written as one file: its bytes are the files of
// the recording's folder, stored as they are (videos and pictures are
// compressed already), between the headers the ZIP format puts around them.
// The layout says where each piece lies, so any range of the zip is read
// from the headers and the files it spans, and finishing a recording takes
// no second copy of it on disk.
//
// Every entry is ZIP64, whatever its size: one way of writing, which every
// current unzip reads (Info-ZIP's, Python's, 7-Zip, macOS's and Windows'
// own), and which a recording of many hours over 4 GiB needs anyway.

/** The time a zip's entries say they were written, in the computer's local time. */
export interface ZipTime {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface ZipEntry<S> {
  /** Its path in the zip, `/`-separated. */
  readonly name: string;
  readonly size: number;
  /** The CRC-32 of its bytes. */
  readonly crc: number;
  /** Where its bytes come from, for the reader. */
  readonly source: S;
}

/** A run of the zip's bytes: header bytes, or `length` bytes of a source from its start. */
export type ZipPiece<S> =
  | { readonly start: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly start: number; readonly length: number; readonly source: S };

export interface ZipLayout<S> {
  readonly size: number;
  /** In order, each starting where the one before ends. */
  readonly pieces: ReadonlyArray<ZipPiece<S>>;
}

const MAX32 = 0xffffffff;
const VERSION = 45; // 4.5: ZIP64.
const UTF8_NAMES = 0x0800;
/** Made on Unix, so the entries carry a file mode. */
const MADE_BY = (3 << 8) | VERSION;
/** A regular file, readable by everyone, writable by its owner. */
const FILE_MODE = 0o100644;

const dos = (time: ZipTime) => ({
  time: ((time.hour & 0x1f) << 11) | ((time.minute & 0x3f) << 5) | ((time.second >> 1) & 0x1f),
  date:
    ((Math.max(0, Math.min(127, time.year - 1980)) & 0x7f) << 9) |
    ((time.month & 0x0f) << 5) |
    (time.day & 0x1f),
});

class Writer {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  private at = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number) {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }
  u32(value: number) {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(value: number) {
    this.view.setBigUint64(this.at, BigInt(value), true);
    this.at += 8;
    return this;
  }
  raw(bytes: Uint8Array) {
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
    return this;
  }
}

const encoder = new TextEncoder();

/** Where each entry and the zip's headers lie, for entries of these names, sizes and checksums. */
export const zipLayout = <S>(
  entries: ReadonlyArray<ZipEntry<S>>,
  written: ZipTime,
): ZipLayout<S> => {
  const { time, date } = dos(written);
  const pieces: Array<ZipPiece<S>> = [];
  const central: Array<Uint8Array> = [];
  let at = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Writer(30 + name.length + 20)
      .u32(0x04034b50)
      .u16(VERSION)
      .u16(UTF8_NAMES)
      .u16(0) // stored
      .u16(time)
      .u16(date)
      .u32(entry.crc)
      .u32(MAX32)
      .u32(MAX32)
      .u16(name.length)
      .u16(20)
      .raw(name)
      .u16(0x0001)
      .u16(16)
      .u64(entry.size)
      .u64(entry.size).bytes;
    central.push(
      new Writer(46 + name.length + 28)
        .u32(0x02014b50)
        .u16(MADE_BY)
        .u16(VERSION)
        .u16(UTF8_NAMES)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(entry.crc)
        .u32(MAX32)
        .u32(MAX32)
        .u16(name.length)
        .u16(28)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attributes
        .u32(FILE_MODE * 0x10000)
        .u32(MAX32)
        .raw(name)
        .u16(0x0001)
        .u16(24)
        .u64(entry.size)
        .u64(entry.size)
        .u64(at).bytes,
    );
    pieces.push({ start: at, bytes: local });
    at += local.length;
    if (entry.size > 0) pieces.push({ start: at, length: entry.size, source: entry.source });
    at += entry.size;
  }
  const centralStart = at;
  const centralSize = central.reduce((sum, header) => sum + header.length, 0);
  const tail = new Writer(centralSize + 56 + 20 + 22);
  for (const header of central) tail.raw(header);
  const zip64End = centralStart + centralSize;
  tail
    .u32(0x06064b50)
    .u64(44)
    .u16(MADE_BY)
    .u16(VERSION)
    .u32(0)
    .u32(0)
    .u64(entries.length)
    .u64(entries.length)
    .u64(centralSize)
    .u64(centralStart)
    .u32(0x07064b50)
    .u32(0)
    .u64(zip64End)
    .u32(1)
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(0xffff)
    .u16(0xffff)
    .u32(MAX32)
    .u32(MAX32)
    .u16(0);
  pieces.push({ start: centralStart, bytes: tail.bytes });
  return { size: centralStart + tail.bytes.length, pieces };
};

const pieceLength = <S>(piece: ZipPiece<S>) =>
  "bytes" in piece ? piece.bytes.length : piece.length;

/**
 * Bytes `[start, end)` of the zip, `end` cut to its size, reading each
 * source's part with `read(source, offset, length)`, which must give
 * exactly `length` bytes.
 */
export const readZip = Effect.fn("recording.readZip")(function* <S, E, R>(
  layout: ZipLayout<S>,
  start: number,
  end: number,
  read: (source: S, offset: number, length: number) => Effect.Effect<Uint8Array, E, R>,
) {
  const stop = Math.min(end, layout.size);
  const out = new Uint8Array(Math.max(0, stop - start));
  for (const piece of layout.pieces) {
    const from = Math.max(start, piece.start);
    const to = Math.min(stop, piece.start + pieceLength(piece));
    if (from >= to) continue;
    const bytes =
      "bytes" in piece
        ? piece.bytes.subarray(from - piece.start, to - piece.start)
        : yield* read(piece.source, from - piece.start, to - from);
    out.set(bytes, from - start);
  }
  return out;
});
