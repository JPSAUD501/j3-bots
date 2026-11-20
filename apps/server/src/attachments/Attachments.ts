// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  AttachmentId,
  type BotFile,
  BotId,
  EntryId,
  type EntryTarget,
  Invalid,
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { Layout } from "../Layout.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

/** The longest name `POST /attachments` takes (`HTTP_PATHS.attachments`). */
const MAX_NAME_LENGTH = 200;

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

/** A stored file and where its bytes are. */
export interface StoredFile {
  readonly attachment: Attachment;
  /** Absolute. */
  readonly path: string;
}

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
    /** Stores an upload. Fails with `Invalid("attachment")` for an empty file or unusable metadata. */
    readonly store: (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<Attachment, Invalid>;
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

    const store = Effect.fn("Attachments.store")(function* (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }) {
      const metadata = normalizeAttachmentMetadata(input);
      if (
        input.bytes.length === 0 ||
        metadata === undefined ||
        metadata.name.length > MAX_NAME_LENGTH
      ) {
        return yield* new Invalid({ reason: "attachment" });
      }
      const sha = yield* digest.digestHex(Digest.sha256, input.bytes);
      const storagePath = `${sha.slice(0, 2)}/${sha}`;
      const target = path.join(layout.attachments, storagePath);
      const id = AttachmentId.make(yield* ids.make("att"));
      const at = timeText(yield* DateTime.now);
      yield* blobFiles.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* fs.exists(target))) {
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            const aside = `${target}.${id}.writing`;
            yield* fs.writeFile(aside, input.bytes);
            yield* fs.rename(aside, target);
          }
          yield* transaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO blobs (sha256, size, storage_path, created_at)
                VALUES (${sha}, ${input.bytes.length}, ${storagePath}, ${at})
                ON CONFLICT (sha256) DO NOTHING
              `;
              yield* sql`
                INSERT INTO attachments (id, sha256, name, media_type, source, created_at)
                VALUES (${id}, ${sha}, ${metadata.name}, ${metadata.mediaType}, 'operator', ${at})
              `;
            }),
          );
        }).pipe(Effect.orDie),
      );
      return yield* decodeAttachment({
        id,
        name: metadata.name,
        mediaType: metadata.mediaType,
        size: input.bytes.length,
      }).pipe(Effect.orDie);
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
    const removeBytes = Effect.fn("Attachments.removeBytes")(
      function* (blob: { readonly sha256: string; readonly storage_path: string }) {
        const still = yield* sql`SELECT 1 FROM blobs WHERE sha256 = ${blob.sha256}`;
        if (still.length > 0) return;
        yield* fs.remove(path.join(layout.attachments, blob.storage_path), { force: true });
      },
      blobFiles.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("A blob's bytes were not removed", cause)),
    );

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
      const orphans = yield* sql<{ readonly sha256: string; readonly storage_path: string }>`
        DELETE FROM blobs
        WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = blobs.sha256)
        RETURNING sha256, storage_path
      `;
      for (const blob of orphans) yield* sql.afterCommit(removeBytes(blob));
    }, Effect.orDie);

    return Attachments.of({ store, open, botFiles, ofTarget, purge });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
