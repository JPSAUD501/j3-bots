// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  AttachmentId,
  type BotFile,
  BotId,
  Conflict,
  EntryId,
  type EntryTarget,
  Invalid,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  NonNegativeInt,
} from "@j3-bots/contracts";
import { normalizeAttachmentMetadata } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { sha256 } from "../hash.ts";
import { Ids } from "../Ids.ts";
import { Layout, type PrivateLocationExposed } from "../Layout.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

const AttachmentRow = Schema.Struct({
  id: AttachmentId,
  name: Schema.String,
  media_type: Schema.String,
  size: NonNegativeInt,
  storage_path: Schema.String,
  entry_id: Schema.NullOr(EntryId),
  created_at: Time,
});

const decodeAttachment = Schema.decodeUnknownEffect(Attachment);

/** A blob's digest and where its bytes are, under the attachments folder. */
interface BlobFile {
  readonly sha256: string;
  readonly storage_path: string;
}

/** A stored file and where its bytes are. */
export interface StoredFile {
  readonly attachment: Attachment;
  /** Absolute. */
  readonly path: string;
}

/** A file to store: an operator's upload, or with `bot` a file that bot delivers. */
export interface NewFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly bot?: BotId;
}

/**
 * A file the server wrote itself under the attachments folder, to store as an
 * attachment of the operator's: a screen recording, uploaded in pieces.
 */
export interface PlacedFile {
  /** The attachment's id, which the caller chose and may have kept. */
  readonly id: AttachmentId;
  readonly name: string;
  readonly mediaType: string;
  /** Absolute, under the attachments folder, so it moves into the store by a rename. */
  readonly from: string;
}

/**
 * The name and media type the store keeps for a file: those the engine's
 * upload takes once normalized, with a name of at most
 * `MAX_ATTACHMENT_NAME_LENGTH`; `undefined` for metadata it refuses.
 */
export const storedMetadata = (file: { readonly name: string; readonly mediaType: string }) => {
  const metadata = normalizeAttachmentMetadata(file);
  return metadata !== undefined && metadata.name.length <= MAX_ATTACHMENT_NAME_LENGTH
    ? metadata
    : undefined;
};

/**
 * Whether the store takes a file of this name, media type and size: not
 * empty, at most `MAX_ATTACHMENT_SIZE`, and metadata it keeps
 * (`storedMetadata`). A caller storing several files together checks them
 * all first, so a file the store would refuse never leaves the others' bytes
 * written.
 */
export const isStorable = (file: {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}): boolean =>
  file.size > 0 && file.size <= MAX_ATTACHMENT_SIZE && storedMetadata(file) !== undefined;

/**
 * Stores one file, in the transaction of the caller of `withStore`. Fails with
 * `Invalid("attachment")` for an empty file, one above `MAX_ATTACHMENT_SIZE`
 * or unusable metadata, before
 * anything is written, and with `Conflict("private-location")`, writing no
 * bytes, when the attachments folder has left private state.
 */
export type PutFile = (file: NewFile) => Effect.Effect<Attachment, Invalid | Conflict>;

/**
 * Files the operator sent and files bots delivered
 * (`docs/architecture/server.md`, Attachments). The bytes are a blob, stored
 * once per SHA-256 under `<J3_HOME>/attachments/<first two hex>/<digest>`; an
 * attachment is a name and a media type over a blob, so the same bytes under
 * two names are one blob and two attachments.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /**
     * Stores an operator's upload, or with `bot` a file that bot delivers, in
     * a transaction of its own. Fails with `Invalid("attachment")` for an
     * empty file, one above `MAX_ATTACHMENT_SIZE` or unusable metadata, and
     * with `Conflict("private-location")`,
     * storing nothing, when the attachments folder has left private state.
     */
    readonly store: (file: NewFile) => Effect.Effect<Attachment, Invalid | Conflict>;
    /**
     * Stores a file the server wrote under the attachments folder as an
     * operator's attachment, in a transaction of its own, reading it a piece
     * at a time for its digest and moving it into place by a rename, so a
     * file of gigabytes is never held in memory or written twice. Once
     * stored, the file at `from` is gone: moved, or removed when the store
     * held its bytes already. Fails, leaving it, with `Invalid("attachment")`
     * for an empty file or metadata the store does not keep, and with
     * `Conflict("private-location")` when the attachments folder has left
     * private state. Nothing else may write `from` meanwhile.
     */
    readonly storeFile: (file: PlacedFile) => Effect.Effect<Attachment, Invalid | Conflict>;
    /**
     * Holds the store's file lock while `use` runs, for a caller that stores
     * files together with records of its own: `use` opens one transaction,
     * and stores each file in it with `put`. The lock is always taken before
     * a transaction and never inside one, by an upload, a bot's `say` and a
     * blob's removal alike, so the two never wait on each other in turn.
     * Never called inside a transaction. Bytes `put` wrote that no blob
     * refers to once `use` ends, because its transaction rolled back, are
     * removed before the lock is released.
     */
    readonly withStore: <A, E, R>(
      use: (put: PutFile) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly open: (id: AttachmentId) => Effect.Effect<Option.Option<StoredFile>>;
    /** Files the bot delivered with a message, newest first, before `before`. */
    readonly botFiles: (input: {
      readonly botId: BotId;
      readonly before: AttachmentId | null;
      readonly limit: number;
    }) => Effect.Effect<{ readonly files: ReadonlyArray<BotFile>; readonly hasOlder: boolean }>;
    /** The attachments carried by the entries of a conversation or room. */
    readonly ofTarget: (target: EntryTarget) => Effect.Effect<ReadonlyArray<AttachmentId>>;
    /**
     * Removes those of `ids` that no entry and no dispatch refers to any more,
     * and the blobs left without an attachment, in the caller's transaction.
     * The bytes are removed once it commits.
     */
    readonly purge: (ids: ReadonlyArray<AttachmentId>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/attachments/Attachments") {}

export const layer = Layer.effect(
  Attachments,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const digest = yield* Digest.Digest;
    const ids = yield* Ids;
    // Writing a blob's file and removing one never interleave, so a removal
    // never takes the bytes of a blob an upload has just stored again.
    const blobFiles = yield* Semaphore.make(1);

    const SELECT = sql.literal(`
      SELECT a.id, a.name, a.media_type, b.size, b.storage_path, a.entry_id, a.created_at
      FROM attachments a JOIN blobs b ON b.sha256 = a.sha256
    `);

    const rowById = SqlSchema.findOneOption({
      Request: AttachmentId,
      Result: AttachmentRow,
      execute: (id) => sql`${SELECT} WHERE a.id = ${id}`,
    });

    const toAttachment = Effect.fn("Attachments.toAttachment")(function* (
      row: typeof AttachmentRow.Type,
    ) {
      return yield* decodeAttachment({
        id: row.id,
        name: row.name,
        mediaType: row.media_type,
        size: row.size,
      });
    }, Effect.orDie);

    /**
     * Puts a blob's bytes in place unless they are there, with `place`
     * writing them at the target; runs under the file lock. Each blob whose
     * bytes it places is added to `written`. Succeeds with where they are
     * and whether this placed them.
     */
    const placeBlob = Effect.fn("Attachments.placeBlob")(function* (
      written: Array<BlobFile>,
      sha: string,
      place: (target: string) => Effect.Effect<void, PrivateLocationExposed | PlatformError>,
    ) {
      const storagePath = `${sha.slice(0, 2)}/${sha}`;
      const target = path.join(layout.attachments, storagePath);
      if (yield* fs.exists(target).pipe(Effect.orDie)) return { storagePath, placed: false };
      // One step an interruption waits out: a rename the file system
      // finishes after the caller gave up is still counted for removal.
      yield* Effect.uninterruptible(
        place(target).pipe(
          Effect.andThen(
            Effect.sync(() => written.push({ sha256: sha, storage_path: storagePath })),
          ),
        ),
      ).pipe(
        Effect.catchTags({
          // Logged here; the caller learns only that nothing was stored.
          PrivateLocationExposed: (exposed) =>
            Effect.logWarning(exposed.message).pipe(
              Effect.andThen(Effect.fail(new Conflict({ reason: "private-location" }))),
            ),
          PlatformError: Effect.die,
        }),
      );
      return { storagePath, placed: true };
    });

    /** The rows of an attachment over a blob, in the caller's transaction. */
    const insertRows = Effect.fn("Attachments.insertRows")(function* (row: {
      readonly id: AttachmentId;
      readonly sha: string;
      readonly size: number;
      readonly storagePath: string;
      readonly metadata: { readonly name: string; readonly mediaType: string };
      readonly bot: BotId | undefined;
    }) {
      const at = timeText(yield* DateTime.now);
      yield* sql`
          INSERT INTO blobs (sha256, size, storage_path, created_at)
          VALUES (${row.sha}, ${row.size}, ${row.storagePath}, ${at})
          ON CONFLICT (sha256) DO NOTHING
        `;
      yield* sql`
          INSERT INTO attachments (id, sha256, name, media_type, source, bot_id, created_at)
          VALUES (
            ${row.id}, ${row.sha}, ${row.metadata.name}, ${row.metadata.mediaType},
            ${row.bot === undefined ? "operator" : "bot"}, ${row.bot ?? null}, ${at}
          )
        `;
      return yield* decodeAttachment({
        id: row.id,
        name: row.metadata.name,
        mediaType: row.metadata.mediaType,
        size: row.size,
      });
    }, Effect.orDie);

    /**
     * Writes the blob's bytes unless they are there, and the rows; runs under
     * the file lock. Each blob whose bytes it writes is added to `written`.
     */
    const put = (written: Array<BlobFile>): PutFile =>
      Effect.fn("Attachments.put")(function* (file: NewFile) {
        const metadata = storedMetadata(file);
        if (metadata === undefined || !isStorable({ ...file, size: file.bytes.length })) {
          return yield* new Invalid({ reason: "attachment" });
        }
        const sha = yield* digest.digestHex(Digest.sha256, file.bytes);
        const id = AttachmentId.make(yield* ids.make("att"));
        const { storagePath } = yield* placeBlob(written, sha, (target) =>
          layout.writeFile(target, file.bytes),
        );
        return yield* insertRows({
          id,
          sha,
          size: file.bytes.length,
          storagePath,
          metadata,
          bot: file.bot,
        });
      });

    /**
     * Removes a blob's bytes unless a row refers to them; the caller holds the
     * file lock. A link above the blob would lead the removal out of private
     * state, so its folder is checked first.
     */
    const removeUnreferenced = Effect.fn("Attachments.removeUnreferenced")(
      function* (blob: BlobFile) {
        const still = yield* sql`SELECT 1 FROM blobs WHERE sha256 = ${blob.sha256}`;
        if (still.length > 0) return;
        const file = path.join(layout.attachments, blob.storage_path);
        yield* layout.writable(path.dirname(file));
        yield* fs.remove(file, { force: true });
      },
      Effect.catchCause((cause) => Effect.logWarning("A blob's bytes were not removed", cause)),
    );

    /** Holds the file lock while `use` places blobs, then removes those no row came to refer to. */
    const withBlobs = <A, E, R>(use: (written: Array<BlobFile>) => Effect.Effect<A, E, R>) =>
      blobFiles.withPermits(1)(
        Effect.suspend(() => {
          const written: Array<BlobFile> = [];
          // Bytes written for a transaction that rolled back have no blob row.
          return use(written).pipe(
            Effect.ensuring(Effect.forEach(written, removeUnreferenced, { discard: true })),
          );
        }),
      );

    const withStore = <A, E, R>(use: (put: PutFile) => Effect.Effect<A, E, R>) =>
      withBlobs((written) => use(put(written)));

    const store = (file: NewFile) => withStore((putFile) => transaction(putFile(file)));

    const storeFile = Effect.fn("Attachments.storeFile")(function* (file: PlacedFile) {
      const metadata = storedMetadata(file);
      if (metadata === undefined) return yield* new Invalid({ reason: "attachment" });
      // Read before the lock is taken: a recording takes a while to read.
      const hash = sha256();
      let size = 0;
      yield* fs.stream(file.from).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            size += chunk.byteLength;
            hash.update(chunk);
          }),
        ),
        Effect.orDie,
      );
      if (size === 0) return yield* new Invalid({ reason: "attachment" });
      const sha = hash.hex();
      const stored = yield* withBlobs((written) =>
        transaction(
          Effect.gen(function* () {
            const { storagePath, placed } = yield* placeBlob(written, sha, (target) =>
              layout.writable(path.dirname(target)).pipe(
                Effect.tap((folder) => fs.makeDirectory(folder, { recursive: true })),
                Effect.andThen(fs.rename(file.from, target)),
              ),
            );
            const attachment = yield* insertRows({
              id: file.id,
              sha,
              size,
              storagePath,
              metadata,
              bot: undefined,
            });
            return { attachment, placed };
          }),
        ),
      );
      // The store held these bytes already.
      if (!stored.placed) {
        yield* fs
          .remove(file.from, { force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A file already in the store was not removed", cause),
            ),
          );
      }
      return stored.attachment;
    });

    const open = Effect.fn("Attachments.open")(function* (id: AttachmentId) {
      const row = yield* rowById(id).pipe(Effect.orDie);
      if (Option.isNone(row)) return Option.none<StoredFile>();
      return Option.some({
        attachment: yield* toAttachment(row.value),
        path: path.join(layout.attachments, row.value.storage_path),
      });
    });

    const botFiles = Effect.fn("Attachments.botFiles")(function* (input: {
      readonly botId: BotId;
      readonly before: AttachmentId | null;
      readonly limit: number;
    }) {
      const cursor =
        input.before === null ? Option.none() : yield* rowById(input.before).pipe(Effect.orDie);
      const rows = yield* sql`
        ${SELECT}
        WHERE a.bot_id = ${input.botId} AND a.source = 'bot' AND a.entry_id IS NOT NULL
          ${Option.match(cursor, {
            onNone: () => sql``,
            onSome: (row) =>
              sql`AND (a.created_at, a.id) < (${timeText(row.created_at)}, ${row.id})`,
          })}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${input.limit + 1}
      `.pipe(Effect.orDie);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(AttachmentRow))(rows).pipe(
        Effect.orDie,
      );
      const files: Array<BotFile> = [];
      for (const row of decoded.slice(0, input.limit)) {
        if (row.entry_id === null) continue;
        files.push({
          attachment: yield* toAttachment(row),
          entryId: row.entry_id,
          createdAt: row.created_at,
        });
      }
      return { files, hasOlder: decoded.length > input.limit };
    });

    const ofTarget = Effect.fn("Attachments.ofTarget")(function* (target: EntryTarget) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT a.id FROM attachments a JOIN entries e ON e.id = a.entry_id
        WHERE ${
          target._tag === "conversation"
            ? sql`e.conversation_bot_id = ${target.botId}`
            : sql`e.room_id = ${target.roomId}`
        }
      `;
      return rows.map((row) => AttachmentId.make(row.id));
    }, Effect.orDie);

    /** Removes a blob's bytes once no row refers to them. */
    const removeBytes = (blob: BlobFile) => blobFiles.withPermits(1)(removeUnreferenced(blob));

    const purge = Effect.fn("Attachments.purge")(function* (
      attachmentIds: ReadonlyArray<AttachmentId>,
    ) {
      if (attachmentIds.length === 0) return;
      yield* sql`
        DELETE FROM attachments
        WHERE ${sql.in("id", attachmentIds)} AND entry_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_attachments d WHERE d.attachment_id = attachments.id
          )
      `;
      const orphans = yield* sql<BlobFile>`
        DELETE FROM blobs
        WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = blobs.sha256)
        RETURNING sha256, storage_path
      `;
      for (const blob of orphans) yield* sql.afterCommit(removeBytes(blob));
    }, Effect.orDie);

    return Attachments.of({ store, storeFile, withStore, open, botFiles, ofTarget, purge });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
