// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Reading a zip's entries where they lie takes positional reads, and inflating them takes zlib's raw inflate, neither of which Effect's platform offers.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The zip of a browser release, unpacked into an empty folder: what Chrome
// for Testing ships. Only what such an archive holds is read: entries stored
// or deflated, files, folders and links, no zip64. Every name is checked to
// stay inside the folder before anything is written, and a link may point
// only inside it too.

/** The archive is not one this reader unpacks, or a write failed. */
export class UnzipFailed extends Schema.TaggedError<UnzipFailed>()("UnzipFailed", {
  detail: Schema.String,
}) {}

const failed = (detail: string) => new UnzipFailed({ detail });
const isUnzipFailed = Schema.is(UnzipFailed);

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record, and the longest comment a zip may end with. */
const MAX_TAIL = 22 + 0xffff;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
/** No file of a browser comes near this; one that does is not the release. */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  /** The Unix mode, when the archive was made on Unix. */
  readonly mode: number | null;
}

const withFile = <A>(
  archive: string,
  use: (fd: number) => Promise<A>,
): Effect.Effect<A, UnzipFailed> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFs.promises.open(archive, "r"),
      catch: () => failed("The archive could not be opened."),
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => use(handle.fd),
        catch: (cause) =>
          isUnzipFailed(cause) ? cause : failed(`The archive could not be read: ${cause}`),
      }),
    (handle) => Effect.promise(() => handle.close()),
  );

const readAt = (fd: number, position: number, length: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    NodeFs.read(fd, buffer, 0, length, position, (error, read) => {
      if (error !== null) reject(error);
      else if (read !== length) reject(failed("The archive ends early."));
      else resolve(buffer);
    });
  });

const directoryOf = async (fd: number, size: number): Promise<ReadonlyArray<Entry>> => {
  const tailLength = Math.min(size, MAX_TAIL);
  const tail = await readAt(fd, size - tailLength, tailLength);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw failed("The archive has no directory.");
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw failed("The archive is a zip64 one.");
  if (directoryOffset + directorySize > size) throw failed("The archive's directory is cut.");
  const directory = await readAt(fd, directoryOffset, directorySize);
  const entries: Array<Entry> = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== DIRECTORY_ENTRY)
      throw failed("The archive's directory is damaged.");
    const madeBy = directory.readUInt16LE(at + 4) >> 8;
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const compressedSize = directory.readUInt32LE(at + 20);
    const entrySize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    const localOffset = directory.readUInt32LE(at + 42);
    if ((flags & 0x1) !== 0) throw failed("The archive is encrypted.");
    if (method !== 0 && method !== 8) throw failed("The archive uses an unknown compression.");
    if (entrySize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES)
      throw failed("An entry is too large.");
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
    entries.push({
      name,
      method,
      compressedSize,
      size: entrySize,
      localOffset,
      mode: madeBy === UNIX_HOST ? external >>> 16 : null,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

/** The entry's bytes, inflated and of the size its directory says. */
const contentOf = async (fd: number, entry: Entry): Promise<Buffer> => {
  const header = await readAt(fd, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw failed("An entry's header is damaged.");
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const stored = await readAt(fd, start, entry.compressedSize);
  const bytes =
    entry.method === 0 ? stored : NodeZlib.inflateRawSync(stored, { maxOutputLength: entry.size });
  if (bytes.length !== entry.size) throw failed("An entry's size is not the one it says.");
  return bytes;
};

/** `name` inside `into`, or null when it would lead out of it. */
const inside = (into: string, name: string): string | null => {
  if (name.includes("\0") || NodePath.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return null;
  const target = NodePath.resolve(into, name);
  const relative = NodePath.relative(into, target);
  return relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)
    ? null
    : target;
};

/** Unpacks the zip `archive` into the empty folder `into`. */
export const unzip = (archive: string, into: string): Effect.Effect<void, UnzipFailed> =>
  Effect.gen(function* () {
    const root = NodePath.resolve(into);
    yield* withFile(archive, async (fd) => {
      const { size } = await NodeFs.promises.stat(archive);
      const entries = await directoryOf(fd, size);
      const links: Array<{ readonly target: string; readonly to: string }> = [];
      for (const entry of entries) {
        const target = inside(root, entry.name);
        if (target === null) throw failed(`An entry leads out of the folder: ${entry.name}`);
        const type = entry.mode === null ? null : entry.mode & S_IFMT;
        if (entry.name.endsWith("/") || type === S_IFDIR) {
          await NodeFs.promises.mkdir(target, { recursive: true, mode: 0o755 });
          continue;
        }
        await NodeFs.promises.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o755 });
        const bytes = await contentOf(fd, entry);
        if (type === S_IFLNK) {
          // Made last, so no file is written through one.
          links.push({ target, to: bytes.toString("utf8") });
          continue;
        }
        const mode = entry.mode !== null && (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
        await NodeFs.promises.writeFile(target, bytes, { mode, flag: "wx" });
      }
      for (const link of links) {
        const resolved = NodePath.resolve(NodePath.dirname(link.target), link.to);
        if (inside(root, NodePath.relative(root, resolved)) === null)
          throw failed("A link leads out of the folder.");
        await NodeFs.promises.symlink(link.to, link.target);
      }
    });
  });
