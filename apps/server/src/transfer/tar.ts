// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A gzipped tar is streamed through node:zlib and node:fs; Effect has neither gzip nor file streams with a byte limit.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The archive an export writes and an import reads: a gzipped tar of regular
// files only, written and read here, in the process, so it needs no `tar` on
// the system and reads the same on Windows. Each file has a POSIX ustar
// header; a name longer than the header holds, or a size past its eleven
// octal digits, goes before it in a PAX extended header. Nothing else of tar
// is read: a link, a device or a folder entry makes the archive unreadable.

const BLOCK = 512;

/** What is wrong with an archive, raised as it is read and told as `ArchiveUnreadable`. */
class Refusal extends Schema.TaggedError<Refusal>()("Refusal", { detail: Schema.String }) {}
const isRefusal = Schema.is(Refusal);
/** The largest size the header's eleven octal digits hold. */
const OCTAL_SIZE_LIMIT = 8 ** 11 - 1;
/** The most an extended header may hold: a name and a size are a few kilobytes. */
const PAX_LIMIT = 64 * 1024;
/** The most bytes one file's name may take. */
const NAME_LIMIT = 4096;

/** A file the archive gets, read from the disk. */
export interface DiskEntry {
  readonly _tag: "disk";
  /** Its name in the archive, `/` between its parts. */
  readonly name: string;
  readonly source: string;
  /** Its size and SHA-256 when they were measured: the file must still have them. */
  readonly size: number;
  readonly sha256: string;
  /** Whether its owner may run it, as a skill's script: an import keeps that. */
  readonly executable: boolean;
}

/** A file the archive gets from memory. */
export interface BytesEntry {
  readonly _tag: "bytes";
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type TarEntry = DiskEntry | BytesEntry;

/**
 * A file to write changed after it was measured: the archive would not hold
 * what its manifest says, so none is written.
 */
export class FileChanged extends Schema.TaggedError<FileChanged>()("FileChanged", {
  entry: Schema.String,
}) {
  override get message(): string {
    return `${this.entry} changed while it was being exported, so no archive was written. Make sure nothing writes to the data directory, and export again.`;
  }
}

const isFileChanged = Schema.is(FileChanged);

/** Writing the archive failed: the disk, or the folder it goes to. */
class ArchiveNotWritten extends Schema.TaggedError<ArchiveNotWritten>()("ArchiveNotWritten", {
  file: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `The export could not be written to ${this.file} (${this.detail}).`;
  }
}

/** A file to export could not be read. */
class FileUnreadable extends Schema.TaggedError<FileUnreadable>()("FileUnreadable", {
  file: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.file} could not be read for the export (${this.detail}).`;
  }
}

/** A file's size and SHA-256, read through once, and whether its owner may run it. */
export const measureFile = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      const { mode } = await NodeFsPromises.stat(file);
      const hash = NodeCrypto.createHash("sha256");
      let size = 0;
      for await (const chunk of NodeFs.createReadStream(file)) {
        if (!(chunk instanceof Buffer)) throw new TypeError("not bytes");
        size += chunk.length;
        hash.update(chunk);
      }
      return { size, sha256: hash.digest("hex"), executable: (mode & 0o100) !== 0 };
    },
    catch: (error) =>
      new FileUnreadable({ file, detail: error instanceof Error ? error.message : "unknown" }),
  });

/** Why an archive cannot be read: not a gzipped tar, or one with more than regular files in it. */
class ArchiveUnreadable extends Schema.TaggedError<ArchiveUnreadable>()("ArchiveUnreadable", {
  file: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.file} is not a J3 Bots export, or it is damaged (${this.detail}).`;
  }
}

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Writes `text` into `block` at `offset`, cut to `width` bytes. */
const put = (block: Buffer, offset: number, width: number, text: string) => {
  block.write(text, offset, width, "utf8");
};

/** The bytes of a ustar header for a regular file or a PAX header (`type`). */
const header = (name: string, size: number, type: "0" | "x", mtime: number, mode: number) => {
  const block = Buffer.alloc(BLOCK);
  put(block, 0, 100, name);
  put(block, 100, 8, octal(mode, 8));
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(block, 124, 12, octal(Math.min(size, OCTAL_SIZE_LIMIT), 12));
  put(block, 136, 12, octal(mtime, 12));
  // The checksum is summed with its own field as spaces.
  block.fill(0x20, 148, 156);
  put(block, 156, 1, type);
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

/** A PAX record: its own length in decimal, which counts itself, then `key=value\n`. */
const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const digits = String(bodyBytes).length;
  let length = bodyBytes + digits;
  if (String(length).length > digits) length += 1;
  return `${length}${body}`;
};

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** The headers that go before a file's bytes: a PAX one when the ustar one cannot hold it. */
const headersOf = (
  name: string,
  size: number,
  mtime: number,
  mode: number,
): ReadonlyArray<Buffer> => {
  const records = [
    ...(Buffer.byteLength(name, "utf8") > 100 ? [paxRecord("path", name)] : []),
    ...(size > OCTAL_SIZE_LIMIT ? [paxRecord("size", String(size))] : []),
  ];
  if (records.length === 0) return [header(name, size, "0", mtime, mode)];
  const pax = Buffer.from(records.join(""), "utf8");
  return [
    header("PaxHeader", pax.length, "x", mtime, 0o600),
    pax,
    padding(pax.length),
    header(Buffer.from(name, "utf8").subarray(0, 100).toString("utf8"), size, "0", mtime, mode),
  ];
};

/** A file's bytes, failing with `Changed` unless they are the size and digest measured. */
async function* bytesOfDisk(entry: DiskEntry): AsyncGenerator<Buffer> {
  const hash = NodeCrypto.createHash("sha256");
  let read = 0;
  // One byte past the size: a file that grew is told from one that did not.
  for await (const chunk of NodeFs.createReadStream(entry.source, { start: 0, end: entry.size })) {
    if (!(chunk instanceof Buffer)) throw new FileChanged({ entry: entry.name });
    read += chunk.length;
    if (read > entry.size) throw new FileChanged({ entry: entry.name });
    hash.update(chunk);
    yield chunk;
  }
  if (read !== entry.size || hash.digest("hex") !== entry.sha256)
    throw new FileChanged({ entry: entry.name });
}

async function* archiveOf(entries: ReadonlyArray<TarEntry>, mtime: number) {
  for (const entry of entries) {
    const size = entry._tag === "bytes" ? entry.bytes.length : entry.size;
    const mode = entry._tag === "disk" && entry.executable ? 0o700 : 0o600;
    yield* headersOf(entry.name, size, mtime, mode);
    if (entry._tag === "bytes") yield Buffer.from(entry.bytes);
    else yield* bytesOfDisk(entry);
    yield padding(size);
  }
  // The end of the archive: two empty blocks.
  yield Buffer.alloc(2 * BLOCK);
}

/**
 * Writes `entries`, in order, as a gzipped tar at `file`, a file that must
 * not exist yet, private to this user (0600). Nothing is left at `file` when
 * it fails.
 */
export const writeTarGz = (file: string, entries: ReadonlyArray<TarEntry>, at: Date) =>
  Effect.tryPromise({
    try: async () => {
      const output = NodeFs.createWriteStream(file, { flags: "wx", mode: 0o600 });
      // Only a file this call made is removed: one already there stays as it was.
      let made = false;
      output.once("open", () => {
        made = true;
      });
      try {
        await NodeStreamPromises.pipeline(
          NodeStream.Readable.from(archiveOf(entries, Math.floor(at.getTime() / 1000))),
          NodeZlib.createGzip(),
          output,
        );
      } catch (error) {
        if (made) await NodeFsPromises.rm(file, { force: true });
        throw error;
      }
    },
    catch: (error) =>
      isFileChanged(error)
        ? error
        : new ArchiveNotWritten({
            file,
            detail: error instanceof Error ? error.message : "unknown",
          }),
  });

/** Reads a stream in exact amounts, or in pieces up to an amount, pausing it between. */
class Reader {
  private readonly chunks: AsyncIterator<unknown>;
  private held: Buffer = Buffer.alloc(0);

  constructor(stream: AsyncIterable<unknown>) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    const next = await this.chunks.next();
    if (next.done === true) return false;
    if (!(next.value instanceof Buffer)) throw new Refusal({ detail: "not bytes" });
    this.held = this.held.length === 0 ? next.value : Buffer.concat([this.held, next.value]);
    return true;
  }

  /** Exactly `size` bytes, or null at the end of the stream. */
  async exactly(size: number): Promise<Buffer | null> {
    while (this.held.length < size) {
      if (!(await this.more())) {
        if (this.held.length === 0) return null;
        throw new Refusal({ detail: "cut short" });
      }
    }
    const taken = this.held.subarray(0, size);
    this.held = this.held.subarray(size);
    return taken;
  }

  /** Up to `size` bytes, at least one. */
  async upTo(size: number): Promise<Buffer> {
    if (this.held.length === 0 && !(await this.more())) throw new Refusal({ detail: "cut short" });
    const taken = this.held.subarray(0, Math.min(size, this.held.length));
    this.held = this.held.subarray(taken.length);
    return taken;
  }
}

/** A header field's text, up to its first NUL. */
const field = (block: Buffer, offset: number, width: number) => {
  const raw = block.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString("utf8");
};

const numberOf = (block: Buffer, offset: number, width: number) => {
  const text = field(block, offset, width).trim();
  if (!/^[0-7]+$/.test(text)) throw new Refusal({ detail: "a header's number is not octal" });
  return Number.parseInt(text, 8);
};

const checksumHolds = (block: Buffer) => {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return numberOf(block, 148, 8) === sum;
};

const SPACE = 0x20;
const NEWLINE = 0x0a;
const EQUALS = 0x3d;

/** A PAX header's records, read in one pass, of which only `path` and `size` are kept. */
const paxOf = (bytes: Buffer) => {
  const unreadable = () => new Refusal({ detail: "an extended header does not read" });
  const found: { path?: string; size?: number } = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(SPACE, at);
    const digits = space === -1 ? "" : bytes.toString("latin1", at, space);
    if (!/^[1-9]\d{0,5}$/.test(digits)) throw unreadable();
    const end = at + Number(digits);
    if (end > bytes.length || bytes[end - 1] !== NEWLINE) throw unreadable();
    const equals = bytes.indexOf(EQUALS, space + 1);
    if (equals === -1 || equals >= end - 1) throw unreadable();
    const key = bytes.toString("utf8", space + 1, equals);
    const value = bytes.toString("utf8", equals + 1, end - 1);
    if (key === "path") found.path = value;
    if (key === "size") {
      if (!/^\d+$/.test(value)) {
        throw new Refusal({ detail: "an extended header's size does not read" });
      }
      found.size = Number(value);
    }
    at = end;
  }
  return found;
};

/** One file of the archive as it is read: its name and size, with its bytes to come. */
export interface ReadEntry {
  readonly name: string;
  readonly size: number;
  /** Whether its owner may run it. */
  readonly executable: boolean;
}

/** Where an entry's bytes go, as `unpack`'s `place` answers. */
export type Placement =
  | { readonly _tag: "memory"; readonly limit: number }
  | { readonly _tag: "file"; readonly path: string };

/** What `unpack` did with an entry. */
export interface Unpacked {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  /** The bytes of an entry placed in memory. */
  readonly bytes: Buffer | null;
}

/** The gzipped tar at `file`, read by `read` from its first entry on, then closed. */
const reading = <A>(file: string, read: (reader: Reader) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const source = NodeFs.createReadStream(file);
      const gunzip = NodeZlib.createGunzip();
      // `pipe` passes the bytes on, not a failure to read them.
      source.once("error", (error) => gunzip.destroy(error));
      try {
        return await read(new Reader(source.pipe(gunzip)));
      } finally {
        source.destroy();
        gunzip.destroy();
      }
    },
    catch: (error) =>
      new ArchiveUnreadable({
        file,
        detail: isRefusal(error)
          ? error.detail
          : error instanceof Error
            ? error.message
            : "unknown",
      }),
  });

/**
 * Reads the gzipped tar at `file`, entry by entry. `place` says where each
 * entry's bytes go, from its name, its size and the entries before it, or
 * refuses it with a reason. A file is written new (0600), in a folder made
 * private (0700) if missing, never over one that exists, and is on the disk
 * before it is closed. Answers every entry with its SHA-256.
 */
export const unpack = (
  file: string,
  place: (entry: ReadEntry, before: ReadonlyArray<Unpacked>) => Placement | string,
) =>
  reading(file, async (reader) => {
    const done: Array<Unpacked> = [];
    while (true) {
      const entry = await nextEntry(reader);
      if (entry === null) return done;
      const placement = place(entry, done);
      if (typeof placement === "string") throw new Refusal({ detail: placement });
      done.push(await readBody(reader, entry, placement));
    }
  });

/**
 * The first entry of the gzipped tar at `file`, which must be named `name`,
 * read into memory up to `limit` bytes; nothing after it is read.
 */
export const readFirst = (file: string, name: string, limit: number) =>
  reading(file, async (reader) => {
    const entry = await nextEntry(reader);
    if (entry === null || entry.name !== name) {
      throw new Refusal({ detail: `its first file is not ${name}` });
    }
    return readBody(reader, entry, { _tag: "memory", limit });
  });

/**
 * The next file's header, after the one extended header that may name it;
 * null at the end. An export writes at most one before a file, so a second
 * is refused: nothing an archive holds keeps the reader on its headers.
 */
const nextEntry = async (reader: Reader): Promise<ReadEntry | null> => {
  let extended: { path?: string; size?: number } | null = null;
  while (true) {
    const block = await reader.exactly(BLOCK);
    if (block === null || block.every((byte) => byte === 0)) {
      if (extended !== null) throw new Refusal({ detail: "an extended header names no file" });
      return null;
    }
    if (!checksumHolds(block)) throw new Refusal({ detail: "a header's checksum does not hold" });
    const type = field(block, 156, 1);
    const declared = numberOf(block, 124, 12);
    if (type === "x") {
      if (extended !== null) {
        throw new Refusal({ detail: "a file has more than one extended header" });
      }
      if (declared > PAX_LIMIT) throw new Refusal({ detail: "an extended header is too large" });
      const bytes = (await reader.exactly(declared)) ?? Buffer.alloc(0);
      if (bytes.length !== declared) throw new Refusal({ detail: "cut short" });
      await reader.exactly(padding(declared).length);
      extended = paxOf(bytes);
      continue;
    }
    if (type !== "0" && type !== "") throw new Refusal({ detail: "it holds more than files" });
    const prefix = field(block, 345, 155);
    const name =
      extended?.path ??
      (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
    if (Buffer.byteLength(name, "utf8") > NAME_LIMIT) {
      throw new Refusal({ detail: "a name is too long" });
    }
    const executable = (numberOf(block, 100, 8) & 0o100) !== 0;
    return { name, size: extended?.size ?? declared, executable };
  }
};

/** Writes all of `chunk`: a write may take fewer bytes than it is given, as a quota nears. */
const writeAll = async (target: NodeFsPromises.FileHandle, chunk: Buffer) => {
  let written = 0;
  while (written < chunk.length) {
    const { bytesWritten } = await target.write(chunk, written);
    if (bytesWritten === 0) throw new Refusal({ detail: "the disk took no more bytes" });
    written += bytesWritten;
  }
};

/** The bytes of `entry`, put where `placement` says. */
const readBody = async (
  reader: Reader,
  entry: ReadEntry,
  placement: Placement,
): Promise<Unpacked> => {
  const { name, size } = entry;
  if (placement._tag === "memory" && size > placement.limit) {
    throw new Refusal({ detail: `${name} is too large` });
  }
  const hash = NodeCrypto.createHash("sha256");
  const kept: Array<Buffer> = [];
  let target: NodeFsPromises.FileHandle | null = null;
  if (placement._tag === "file") {
    await NodeFsPromises.mkdir(NodePath.dirname(placement.path), { recursive: true, mode: 0o700 });
    target = await NodeFsPromises.open(placement.path, "wx", entry.executable ? 0o700 : 0o600);
  }
  try {
    let left = size;
    while (left > 0) {
      const chunk = await reader.upTo(Math.min(left, 1024 * 1024));
      left -= chunk.length;
      hash.update(chunk);
      if (target === null) kept.push(Buffer.from(chunk));
      else await writeAll(target, chunk);
    }
    await target?.datasync();
  } finally {
    await target?.close();
  }
  await reader.exactly(padding(size).length);
  return {
    name,
    size,
    sha256: hash.digest("hex"),
    bytes: target === null ? Buffer.concat(kept) : null,
  };
};
