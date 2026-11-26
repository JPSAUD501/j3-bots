// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Reading a zip takes positioned reads, raw inflate and CRC-32, which Effect has no API for.
import * as NodeFs from "node:fs";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { errnoCode, windowsNameKey } from "@j3-bots/processes";

// Unpacks a zip archive in this process: Windows has no `tar` J3 Bots can
// count on, and T3 Code ships its Windows engine as a zip. It reads what the
// pinned archive uses and nothing more: stored and deflated entries, no ZIP64,
// no encryption, no links. The archive is checked against its pinned digest
// before it gets here, so this is not a defence against a hostile archive on
// its own; it still writes only inside the folder it is given, and refuses
// any entry whose name would lead out of it, or that Windows would read as
// another name.

/**
 * Why an archive could not be unpacked, with what in it was refused, and the
 * system's code for a file that could not be written (`write`), such as
 * `ENOSPC` for a full disk.
 */
export class UnzipFailed extends Schema.TaggedError<UnzipFailed>()("UnzipFailed", {
  reason: Schema.Literals(["not-a-zip", "unsupported", "unsafe-name", "corrupt", "write"]),
  detail: Schema.String,
  code: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-zip":
        return `Not a zip archive: ${this.detail}`;
      case "unsupported":
        return `The zip archive uses what this reader does not support: ${this.detail}`;
      case "unsafe-name":
        return `The zip archive holds an entry whose name is not a plain relative path: ${this.detail}`;
      case "corrupt":
        return `The zip archive is damaged: ${this.detail}`;
      case "write":
        return `Unpacking the zip archive failed: ${this.detail}`;
    }
  }
}

const END_RECORD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

const STORED = 0;
const DEFLATED = 8;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
/** The "made by" host for Unix, whose external attributes hold the file mode. */
const HOST_UNIX = 3;
const UNIX_TYPE = 0o170000;
const UNIX_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

/** Where the end record says the central directory is. */
interface EndRecord {
  readonly count: number;
  readonly directoryOffset: number;
  readonly directorySize: number;
}

/** One entry as the central directory lists it. */
interface ZipEntry {
  /** Its path, segments separated by `/`, without a folder's trailing `/`. */
  readonly name: string;
  readonly isDirectory: boolean;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  /** Whether its Unix mode, when the archive keeps one, lets its owner run it. */
  readonly executable: boolean;
}

const refusal = (reason: UnzipFailed["reason"], detail: string, code: string | null = null) =>
  new UnzipFailed({ reason, detail, code });
const fail = (reason: UnzipFailed["reason"], detail: string) =>
  Result.fail(refusal(reason, detail));
const isUnzipFailed = Schema.is(UnzipFailed);

/** Names Windows gives to devices in every folder, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** A character no segment may hold: a control character, or one Windows refuses or reads as something else. */
const REFUSED_CHARACTER = /[\u0000-\u001f<>:"\\|?*]/;

/**
 * Whether `name`, an entry's name with `/` between its segments, is a plain
 * relative path that means the same on every system: no absolute path or
 * drive, no `.` or `..` segment, no backslash (Windows reads it as a
 * separator), no character Windows refuses or reads as something else (a
 * `:` opens an alternate data stream), no segment ending in a dot or a space
 * (Windows drops those, so two names would land on one file), and no device
 * name.
 */
export const isSafeEntryName = (name: string): boolean =>
  (name.endsWith("/") ? name.slice(0, -1) : name)
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !REFUSED_CHARACTER.test(segment) &&
        !/[. ]$/.test(segment) &&
        !DEVICE_NAME.test(segment),
    );

/** The end record in `tail`, the archive's last bytes, which start at `tailOffset`. */
const readEndRecord = (
  tail: Uint8Array,
  tailOffset: number,
  archiveSize: number,
): Result.Result<EndRecord, UnzipFailed> => {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let at = tail.byteLength - END_RECORD_SIZE; at >= 0; at--) {
    if (view.getUint32(at, true) !== END_RECORD) continue;
    if (view.getUint16(at + 4, true) !== 0 || view.getUint16(at + 6, true) !== 0) {
      return fail("unsupported", "an archive split over disks");
    }
    const count = view.getUint16(at + 10, true);
    const directorySize = view.getUint32(at + 12, true);
    const directoryOffset = view.getUint32(at + 16, true);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      return fail("unsupported", "ZIP64");
    }
    if (directoryOffset + directorySize > tailOffset + at) {
      return fail("corrupt", "the central directory runs into its end record");
    }
    return Result.succeed({ count, directoryOffset, directorySize });
  }
  return fail("not-a-zip", archiveSize < END_RECORD_SIZE ? "too short" : "no end record");
};

/** The entries `directory`, the central directory the end record locates, lists. */
const readEntries = (
  directory: Uint8Array,
  end: EndRecord,
): Result.Result<ReadonlyArray<ZipEntry>, UnzipFailed> => {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const entries: Array<ZipEntry> = [];
  const names = new Set<string>();
  let at = 0;
  for (let index = 0; index < end.count; index++) {
    if (
      at + CENTRAL_HEADER_SIZE > directory.byteLength ||
      view.getUint32(at, true) !== CENTRAL_HEADER
    ) {
      return fail("corrupt", `central directory entry ${index} is not where it should be`);
    }
    const madeBy = view.getUint16(at + 4, true) >> 8;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc32 = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameSize = view.getUint16(at + 28, true);
    const extraSize = view.getUint16(at + 30, true);
    const commentSize = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const nameStart = at + CENTRAL_HEADER_SIZE;
    at = nameStart + nameSize + extraSize + commentSize;
    if (at > directory.byteLength) {
      return fail("corrupt", `central directory entry ${index} runs past its end`);
    }

    let raw: string;
    try {
      raw = utf8.decode(directory.subarray(nameStart, nameStart + nameSize));
    } catch {
      return fail("unsafe-name", `entry ${index} is not valid UTF-8`);
    }
    // Without the UTF-8 flag a name is in code page 437, which reads the same only in ASCII.
    if ((flags & FLAG_UTF8) === 0 && /[^\u0020-\u007e]/.test(raw)) {
      return fail("unsafe-name", `${JSON.stringify(raw)} is not in UTF-8`);
    }
    if (!isSafeEntryName(raw)) return fail("unsafe-name", JSON.stringify(raw));
    const isDirectory = raw.endsWith("/");
    const name = isDirectory ? raw.slice(0, -1) : raw;
    if ((flags & FLAG_ENCRYPTED) !== 0) return fail("unsupported", `${name} is encrypted`);
    if (method !== STORED && method !== DEFLATED) {
      return fail("unsupported", `${name} is compressed with method ${method}`);
    }
    const mode = madeBy === HOST_UNIX ? external >>> 16 : 0;
    if (mode !== 0 && (mode & UNIX_TYPE) !== (isDirectory ? UNIX_DIRECTORY : UNIX_FILE)) {
      return fail("unsupported", `${name} is neither a plain file nor a folder`);
    }
    if (isDirectory && (size !== 0 || compressedSize !== 0)) {
      return fail("corrupt", `the folder ${name} holds data`);
    }
    if (localHeaderOffset + LOCAL_HEADER_SIZE + compressedSize > end.directoryOffset) {
      return fail("corrupt", `${name} runs into the central directory`);
    }
    // Two files at one name would let the second replace the first, and
    // Windows names that differ only in case are one name.
    const key = windowsNameKey(name);
    if (!isDirectory && names.has(key)) return fail("corrupt", `${name} is listed twice`);
    names.add(key);
    entries.push({
      name,
      isDirectory,
      method,
      crc32,
      compressedSize,
      size,
      localHeaderOffset,
      executable: (mode & 0o100) !== 0,
    });
  }
  return Result.succeed(entries);
};

/** Passes bytes through, failing once more than the entry's size arrive or its CRC-32 does not match. */
const checked = (entry: ZipEntry) => {
  let received = 0;
  let crc = 0;
  return new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.byteLength;
      if (received > entry.size) {
        done(refusal("corrupt", `${entry.name} holds more than its ${entry.size} bytes`));
        return;
      }
      crc = NodeZlib.crc32(chunk, crc);
      done(null, chunk);
    },
    flush(done) {
      if (received !== entry.size) {
        done(refusal("corrupt", `${entry.name} holds ${received} bytes, not ${entry.size}`));
      } else if (crc >>> 0 !== entry.crc32) {
        done(refusal("corrupt", `${entry.name} does not match its CRC-32`));
      } else {
        done();
      }
    },
  });
};

const failure =
  (reason: UnzipFailed["reason"]) =>
  (cause: unknown): UnzipFailed => {
    if (isUnzipFailed(cause)) return cause;
    const code = errnoCode(cause);
    // zlib's codes for a stream that does not inflate.
    const damaged = code !== null && code.startsWith("Z_");
    return refusal(
      damaged ? "corrupt" : reason,
      cause instanceof Error ? cause.message : String(cause),
      damaged ? null : code,
    );
  };

/**
 * Unpacks the zip archive at `archive` into `into`, an existing, empty folder
 * that only this process writes. Folders are made as needed; each file is
 * created new (nothing may be at its name yet, so nothing there is followed
 * or replaced) and must hold exactly its listed bytes, with their CRC-32. A
 * Unix mode in the archive gives a file its owner's execute bit, which
 * Windows has no use for. Interrupting it stops at the file being written.
 */
export const extractZip = Effect.fn("engine.extractZip")(function* (archive: string, into: string) {
  const handle = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFsPromises.open(archive, "r"),
      catch: failure("not-a-zip"),
    }),
    (opened) => Effect.promise(() => opened.close()),
  );
  const read = (position: number, length: number) =>
    Effect.tryPromise({
      try: async () => {
        const bytes = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(
            bytes,
            filled,
            length - filled,
            position + filled,
          );
          if (bytesRead === 0) throw refusal("corrupt", "the archive ends early");
          filled += bytesRead;
        }
        return bytes;
      },
      catch: failure("corrupt"),
    });

  const { size } = yield* Effect.tryPromise({
    try: () => handle.stat(),
    catch: failure("not-a-zip"),
  });
  const tailOffset = Math.max(0, size - END_RECORD_SIZE - MAX_COMMENT_SIZE);
  const end = yield* Effect.fromResult(
    readEndRecord(yield* read(tailOffset, size - tailOffset), tailOffset, size),
  );
  const entries = yield* Effect.fromResult(
    readEntries(yield* read(end.directoryOffset, end.directorySize), end),
  );

  for (const entry of entries) {
    const target = NodePath.join(into, ...entry.name.split("/"));
    if (entry.isDirectory) {
      yield* Effect.tryPromise({
        try: () => NodeFsPromises.mkdir(target, { recursive: true, mode: 0o700 }),
        catch: failure("write"),
      });
      continue;
    }
    const local = new DataView((yield* read(entry.localHeaderOffset, LOCAL_HEADER_SIZE)).buffer);
    if (local.getUint32(0, true) !== LOCAL_HEADER) {
      return yield* refusal("corrupt", `${entry.name} has no local header`);
    }
    const dataOffset =
      entry.localHeaderOffset +
      LOCAL_HEADER_SIZE +
      local.getUint16(26, true) +
      local.getUint16(28, true);
    if (dataOffset + entry.compressedSize > end.directoryOffset) {
      return yield* refusal("corrupt", `${entry.name} runs into the central directory`);
    }
    yield* Effect.tryPromise({
      try: async (signal) => {
        await NodeFsPromises.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
        const source =
          entry.compressedSize === 0
            ? NodeStream.Readable.from([])
            : NodeFs.createReadStream(archive, {
                start: dataOffset,
                end: dataOffset + entry.compressedSize - 1,
              });
        const inflate = entry.method === DEFLATED ? [NodeZlib.createInflateRaw()] : [];
        await NodeStreamPromises.pipeline(
          [
            source,
            ...inflate,
            checked(entry),
            NodeFs.createWriteStream(target, {
              flags: "wx",
              mode: entry.executable ? 0o700 : 0o600,
            }),
          ],
          { signal },
        );
      },
      catch: failure("write"),
    });
  }
}, Effect.scoped);
