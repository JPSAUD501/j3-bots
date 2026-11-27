// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  AttachmentId,
  Conflict,
  Invalid,
  MAX_RECORDING_SIZE,
  NotFound,
  PositiveInt,
  RECORDING_CHUNK_SIZE,
  RECORDING_MEDIA_TYPE,
  RecordingOffset,
  type RecordingUpload,
  RecordingUploadId,
  type RecordingUploadStart,
} from "@j3-bots/contracts";
import { platformErrorCode } from "@j3-bots/processes";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { removeLeftovers } from "../files.ts";
import { Ids } from "../Ids.ts";
import { writeInPlace } from "../inPlace.ts";
import { Layout } from "../Layout.ts";
import { json } from "../persistence/columns.ts";
import { DiskSpace } from "../system/DiskSpace.ts";
import { Attachments, storedMetadata } from "./Attachments.ts";

/** A piece over `RECORDING_CHUNK_SIZE`, or a recording over `MAX_RECORDING_SIZE`. */
export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {
  override get message(): string {
    return "The recording, or a piece of it, is larger than the server takes.";
  }
}

/** An upload untouched this long is removed, and its id answers as unknown. */
const UPLOAD_LIFETIME = Duration.hours(24);

/** How often uploads are looked over for those past `UPLOAD_LIFETIME`. */
const SWEEP_INTERVAL = Duration.hours(1);

/**
 * The room the disk keeps free beyond what a recording needs, so a recording
 * never leaves the server, its database and its bots without space: 1 GiB.
 */
export const SPACE_RESERVE = 1024 * 1024 * 1024;

/**
 * The free space a recording of `size` bytes needs once `received` of them
 * are on the disk: the bytes still to come, a second copy of the whole file
 * for the bot's workspace (`files/inbox/`), and `SPACE_RESERVE`. The upload's
 * own file becomes the stored file by a rename, so it needs no third copy.
 */
const spaceNeeded = (size: number, received: number) => size - received + size + SPACE_RESERVE;

/**
 * What the server keeps of an upload beside its bytes, in `<id>.json`: the
 * name the file is stored under, its size, when it was last touched, and,
 * once it is being stored, the id its attachment takes.
 */
const UploadRecord = json(
  Schema.Struct({
    name: Schema.String,
    size: PositiveInt,
    touchedAt: Schema.DateTimeUtc,
    attachmentId: Schema.optionalKey(AttachmentId),
  }),
);
type UploadRecord = typeof UploadRecord.Type;
const decodeRecord = Schema.decodeUnknownOption(UploadRecord);
const encodeRecord = Schema.encodeEffect(UploadRecord);

/** The end of central directory record every zip ends with, before a comment of up to 64 KiB. */
const END_OF_CENTRAL_DIRECTORY = [0x50, 0x4b, 0x05, 0x06];
const END_RECORD_LENGTH = 22;
const MAX_ZIP_COMMENT = 0xffff;

/**
 * Whether `tail`, the last bytes of a file, holds a zip's end of central
 * directory record whose comment runs exactly to the end.
 */
const endsAsZip = (tail: Uint8Array): boolean => {
  for (let at = tail.length - END_RECORD_LENGTH; at >= 0; at--) {
    if (!END_OF_CENTRAL_DIRECTORY.every((byte, index) => tail[at + index] === byte)) continue;
    const comment = (tail[at + 20] ?? 0) | ((tail[at + 21] ?? 0) << 8);
    if (at + END_RECORD_LENGTH + comment === tail.length) return true;
  }
  return false;
};

/**
 * Screen recordings (decision 0098), uploaded in pieces that resume: a
 * recording is too large for one request and for memory. While it uploads,
 * its bytes are one file, `attachments/uploads/<id>.part`, appended in place
 * (a link at its name is refused), and the point to resume from is that
 * file's size, so a piece cut off keeps what arrived of it. The piece that
 * completes it stores it as an attachment (`Attachments.storeFile`), and the
 * upload then answers with it for as long as it lives, so a client that lost
 * that answer still gets it. One request at a time writes an upload. An
 * upload untouched for `UPLOAD_LIFETIME` is removed, as it is looked at and
 * once an hour.
 */
export class RecordingUploads extends Context.Service<
  RecordingUploads,
  {
    /**
     * Begins an upload of `size` bytes. Fails with `Invalid("attachment")` for
     * a name the store does not keep, `TooLarge` above `MAX_RECORDING_SIZE`,
     * `Conflict("no-space")` when the disk lacks room for it
     * (`spaceNeeded`), and `Conflict("private-location")`.
     */
    readonly begin: (
      input: RecordingUploadStart,
    ) => Effect.Effect<RecordingUpload, Invalid | TooLarge | Conflict>;
    /** Where the upload stands; `NotFound("attachment")` for none, or one past its lifetime. */
    readonly status: (id: RecordingUploadId) => Effect.Effect<RecordingUpload, NotFound>;
    /**
     * Appends `bytes` at `offset`, which must be where the upload stands
     * (`RecordingOffset` otherwise), and stores the file once every byte is
     * there, also on an empty piece. Fails with `TooLarge` for a piece over
     * `RECORDING_CHUNK_SIZE`, keeping what fit; with `Invalid("attachment")`
     * for one past the size the upload began with, or a whole file that is
     * not a zip, either of which removes the upload; with
     * `Conflict("no-space")` when the disk lacks room for the rest, and with
     * `Conflict("private-location")`. A failure of `bytes` keeps what
     * arrived.
     */
    readonly append: (input: {
      readonly id: RecordingUploadId;
      readonly offset: number;
      readonly bytes: Stream.Stream<Uint8Array, PieceCutOff>;
    }) => Effect.Effect<
      RecordingUpload,
      NotFound | RecordingOffset | TooLarge | Invalid | Conflict | PieceCutOff
    >;
    /** Removes the upload and what arrived of it. */
    readonly cancel: (id: RecordingUploadId) => Effect.Effect<void, NotFound>;
  }
>()("@j3-bots/server/attachments/RecordingUploads") {}

/** A piece stopped arriving before its end: what arrived of it is kept. */
export class PieceCutOff extends Schema.TaggedError<PieceCutOff>()("PieceCutOff", {}) {
  override get message(): string {
    return "The piece stopped arriving before its end.";
  }
}

/** Why a piece was refused while it arrived. */
class Overflow extends Schema.TaggedError<Overflow>()("Overflow", {
  past: Schema.Literals(["chunk", "size"]),
}) {}

export const layer = Layer.effect(
  RecordingUploads,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const ids = yield* Ids;
    const disk = yield* DiskSpace;
    const attachments = yield* Attachments;
    const folder = path.join(layout.attachments, "uploads");
    const partOf = (id: RecordingUploadId) => path.join(folder, `${id}.part`);
    const recordOf = (id: RecordingUploadId) => path.join(folder, `${id}.json`);
    const notFound = new NotFound({ resource: "attachment" });

    // One writer per upload: its lock, made when first needed.
    const locks = new Map<RecordingUploadId, Semaphore.Semaphore>();
    const holding = <A, E, R>(id: RecordingUploadId, effect: Effect.Effect<A, E, R>) => {
      let lock = locks.get(id);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(id, lock);
      }
      return lock.withPermits(1)(effect);
    };

    /** The link was logged; the caller learns only that nothing was written. */
    const exposed = (error: { readonly message: string }) =>
      Effect.logWarning(error.message).pipe(
        Effect.andThen(Effect.fail(new Conflict({ reason: "private-location" }))),
      );

    const writeRecord = Effect.fn("RecordingUploads.writeRecord")(function* (
      id: RecordingUploadId,
      record: UploadRecord,
    ) {
      const text = yield* encodeRecord(record).pipe(Effect.orDie);
      yield* layout.writeFile(recordOf(id), text).pipe(
        Effect.catchTags({
          PrivateLocationExposed: exposed,
          PlatformError: (error) =>
            platformErrorCode(error) === "ENOSPC"
              ? Effect.fail(new Conflict({ reason: "no-space" }))
              : Effect.die(error),
        }),
      );
    });

    const readRecord = (id: RecordingUploadId) =>
      fs.readFileString(recordOf(id)).pipe(
        Effect.map(decodeRecord),
        Effect.orElseSucceed(() => Option.none<UploadRecord>()),
      );

    /** Removes an upload's files, its bytes first: a record left alone is removed next time. */
    const remove = (id: RecordingUploadId) =>
      layout.writable(folder).pipe(
        Effect.andThen(fs.remove(partOf(id), { force: true })),
        Effect.andThen(fs.remove(recordOf(id), { force: true })),
        Effect.catchCause((cause) =>
          Effect.logWarning("An upload's files were not removed", cause),
        ),
      );

    const expired = (record: UploadRecord, now: DateTime.Utc) =>
      DateTime.isGreaterThan(now, DateTime.addDuration(record.touchedAt, UPLOAD_LIFETIME));

    /** The upload's record, unless there is none or it is past its lifetime, which removes it. */
    const live = Effect.fn("RecordingUploads.live")(function* (id: RecordingUploadId) {
      const record = yield* readRecord(id);
      if (Option.isNone(record)) return yield* notFound;
      if (expired(record.value, yield* DateTime.now)) {
        yield* remove(id);
        locks.delete(id);
        return yield* notFound;
      }
      return record.value;
    });

    /**
     * The bytes the upload's file holds: none before its first piece. A link
     * at its name is not the file (`lstat`), so it counts as none, and the
     * next piece refuses to write through it.
     */
    const receivedOf = (id: RecordingUploadId) =>
      fs.lstat(partOf(id)).pipe(
        Effect.map((info) => (info.type === "File" ? Number(info.size) : 0)),
        Effect.orElseSucceed(() => 0),
      );

    /** The attachment the upload became, once stored. */
    const storedAs = (record: UploadRecord) =>
      record.attachmentId === undefined
        ? Effect.succeedNone
        : attachments
            .open(record.attachmentId)
            .pipe(Effect.map(Option.map((stored) => stored.attachment)));

    const standing = Effect.fn("RecordingUploads.standing")(function* (
      id: RecordingUploadId,
      record: UploadRecord,
    ) {
      const stored = yield* storedAs(record);
      if (Option.isSome(stored)) {
        return { id, size: record.size, received: record.size, attachment: stored.value };
      }
      return { id, size: record.size, received: yield* receivedOf(id) } satisfies RecordingUpload;
    });

    /** Fails with `Conflict("no-space")` unless the disk has room for the rest of the upload. */
    const roomFor = Effect.fn("RecordingUploads.roomFor")(function* (
      size: number,
      received: number,
    ) {
      const free = yield* disk.free(folder);
      // A disk whose free space cannot be read is not refused: the write says.
      if (Option.isSome(free) && free.value < spaceNeeded(size, received)) {
        return yield* new Conflict({ reason: "no-space" });
      }
    });

    const begin = Effect.fn("RecordingUploads.begin")(function* (input: RecordingUploadStart) {
      const metadata = storedMetadata({ name: input.name, mediaType: RECORDING_MEDIA_TYPE });
      if (metadata === undefined) return yield* new Invalid({ reason: "attachment" });
      if (input.size > MAX_RECORDING_SIZE) return yield* new TooLarge();
      yield* roomFor(input.size, 0);
      const id = RecordingUploadId.make(yield* ids.make("rec"));
      yield* writeRecord(id, {
        name: metadata.name,
        size: input.size,
        touchedAt: yield* DateTime.now,
      });
      return { id, size: input.size, received: 0 } satisfies RecordingUpload;
    });

    const status = Effect.fn("RecordingUploads.status")(function* (id: RecordingUploadId) {
      return yield* standing(id, yield* live(id));
    });

    /** The last bytes of the upload's file, enough to hold a zip's end record. */
    const tailOf = (id: RecordingUploadId, size: number) =>
      fs
        .stream(partOf(id), {
          offset: Math.max(0, size - END_RECORD_LENGTH - MAX_ZIP_COMMENT),
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunks) => {
            const tail = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
            let at = 0;
            for (const chunk of chunks) {
              tail.set(chunk, at);
              at += chunk.length;
            }
            return tail;
          }),
          Effect.orDie,
        );

    /** Stores the whole upload as an attachment, under the id its record keeps. */
    const complete = Effect.fn("RecordingUploads.complete")(function* (
      id: RecordingUploadId,
      record: UploadRecord,
    ) {
      // Only the file the pieces were written to becomes the attachment,
      // never what a link put at its name leads to.
      const part = yield* fs.lstat(partOf(id)).pipe(Effect.option);
      if (Option.isNone(part) || part.value.type !== "File") {
        return yield* exposed({ message: `${partOf(id)} is not the upload's own file.` });
      }
      if (!endsAsZip(yield* tailOf(id, record.size))) {
        yield* remove(id);
        return yield* new Invalid({ reason: "attachment" });
      }
      // The id is kept before the file moves, so an upload whose file moved
      // and whose answer was lost still finds its attachment.
      const attachmentId = record.attachmentId ?? AttachmentId.make(yield* ids.make("att"));
      const keeping = { ...record, attachmentId, touchedAt: yield* DateTime.now };
      yield* writeRecord(id, keeping);
      const attachment: Attachment = yield* attachments.storeFile({
        id: attachmentId,
        name: record.name,
        mediaType: RECORDING_MEDIA_TYPE,
        from: partOf(id),
      });
      return { id, size: record.size, received: record.size, attachment } satisfies RecordingUpload;
    });

    const append = (input: {
      readonly id: RecordingUploadId;
      readonly offset: number;
      readonly bytes: Stream.Stream<Uint8Array, PieceCutOff>;
    }) =>
      // Known first, so an unknown id never gets a lock.
      live(input.id).pipe(
        Effect.andThen(
          holding(
            input.id,
            Effect.gen(function* () {
              const record = yield* live(input.id);
              const before = yield* standing(input.id, record);
              if (before.attachment !== undefined) {
                if (input.offset === record.size) return before;
                return yield* new RecordingOffset({ received: record.size });
              }
              if (input.offset !== before.received) {
                return yield* new RecordingOffset({ received: before.received });
              }
              if (before.received < record.size) {
                yield* roomFor(record.size, before.received);
                const fits = Math.min(RECORDING_CHUNK_SIZE, record.size - before.received);
                let arrived = 0;
                // A piece is refused as it passes what fits, before those bytes are written.
                const counted = input.bytes.pipe(
                  Stream.mapEffect((chunk) => {
                    arrived += chunk.length;
                    if (arrived <= fits) return Effect.succeed(chunk);
                    return Effect.fail(
                      new Overflow({ past: arrived > RECORDING_CHUNK_SIZE ? "chunk" : "size" }),
                    );
                  }),
                );
                yield* layout.writable(folder).pipe(
                  Effect.catchTag("PrivateLocationExposed", exposed),
                  // Where opening cannot refuse a link (Windows has no O_NOFOLLOW),
                  // anything at the file's name that is not the file is refused first.
                  Effect.andThen(fs.lstat(partOf(input.id)).pipe(Effect.option)),
                  Effect.flatMap((part) =>
                    Option.isSome(part) && part.value.type !== "File"
                      ? exposed({ message: `${partOf(input.id)} is not the upload's own file.` })
                      : Effect.void,
                  ),
                  Effect.andThen(writeInPlace(partOf(input.id), true, counted)),
                  Effect.ensuring(
                    // Touched whatever happened: a piece cut off is progress too.
                    DateTime.now.pipe(
                      Effect.flatMap((now) => writeRecord(input.id, { ...record, touchedAt: now })),
                      Effect.ignore,
                    ),
                  ),
                  Effect.catchTags({
                    Overflow: (overflow) =>
                      overflow.past === "chunk"
                        ? Effect.fail(new TooLarge())
                        : // More than the upload began with: what arrived cannot be the file.
                          remove(input.id).pipe(
                            Effect.andThen(Effect.fail(new Invalid({ reason: "attachment" }))),
                          ),
                    InPlaceFailure: (failure) => {
                      // ELOOP: a link was put at the file's name.
                      if (failure.code === "ELOOP") {
                        return exposed({
                          message: `${failure.file} is a link, so it was not written.`,
                        });
                      }
                      if (failure.code === "ENOSPC") {
                        return Effect.fail(new Conflict({ reason: "no-space" }));
                      }
                      return Effect.die(failure);
                    },
                  }),
                );
              }
              const after = yield* receivedOf(input.id);
              if (after < record.size) {
                return {
                  id: input.id,
                  size: record.size,
                  received: after,
                } satisfies RecordingUpload;
              }
              return yield* complete(input.id, record);
            }),
          ),
        ),
      );

    const cancel = Effect.fn("RecordingUploads.cancel")(function* (id: RecordingUploadId) {
      yield* live(id);
      yield* holding(
        id,
        Effect.gen(function* () {
          yield* live(id);
          yield* remove(id);
        }),
      );
      locks.delete(id);
    });

    /** Removes every upload past its lifetime, and whatever an interrupted write left. */
    const sweep = Effect.gen(function* () {
      if (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) return;
      yield* layout.writable(folder);
      yield* removeLeftovers(folder);
      const now = yield* DateTime.now;
      for (const name of yield* fs.readDirectory(folder)) {
        const match = /^(rec_[0-9a-z]{20})\.(json|part)$/.exec(name);
        const id = match?.[1];
        if (id === undefined) continue;
        const known = RecordingUploadId.make(id);
        yield* holding(
          known,
          Effect.gen(function* () {
            const record = yield* readRecord(known);
            // Bytes whose record is gone belong to no upload.
            if (Option.isNone(record) || expired(record.value, now)) {
              yield* remove(known);
              locks.delete(known);
            }
          }),
        );
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Uploads were not looked over", cause)));

    yield* sweep.pipe(
      Effect.andThen(Effect.sleep(SWEEP_INTERVAL)),
      Effect.forever,
      Effect.forkScoped,
    );

    return RecordingUploads.of({ begin, status, append, cancel });
  }),
);
