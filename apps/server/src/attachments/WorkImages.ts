// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  MAX_WORK_IMAGE_SIZE,
  WorkImageId,
  type WorkStepId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { workspaceReader } from "./workspaceFile.ts";

/** An image as a device is sent it: its bytes, and the type they show. */
export interface WorkImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** The image types a client draws without running anything, by their name's extension. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

const startsWith = (bytes: Uint8Array, at: number, expected: ReadonlyArray<number>) =>
  bytes.length >= at + expected.length &&
  expected.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

/**
 * The image type `bytes` hold, from their first bytes: a GIF, JPEG, PNG or
 * WebP; none for anything else, whatever the file is named. So a file named
 * `.png` that holds a page or an SVG is never served as an image.
 */
export const imageTypeOf = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"))) {
    return "image/gif";
  }
  if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) {
    return "image/webp";
  }
  return undefined;
};

const ImageRow = Schema.Struct({
  bot_id: BotId,
  path: Schema.String,
  workspace_root: Schema.NullOr(Schema.String),
});

/**
 * The images steps of the bots' work looked at (`docs/architecture/server.md`,
 * Images a bot looked at). A step that read an image file in its bot's
 * workspace gets an id for it; a device asks for the image by that id, never
 * by a path, and the server reads it again from the workspace, under the same
 * containment as a file a `say` attaches (`workspaceFile.ts`).
 */
export class WorkImages extends Context.Service<
  WorkImages,
  {
    /**
     * The id of the image the step `stepId` of the work fold `entryId` looked
     * at, which the bot's harness read at `given`, in the caller's
     * transaction: the one it already has, or a new one when `given` is a GIF,
     * JPEG, PNG or WebP by its name, inside the bot's workspace as it resolves
     * now. None for anything else, which the step shows without an image.
     */
    readonly record: (input: {
      readonly botId: BotId;
      readonly entryId: EntryId;
      readonly stepId: WorkStepId;
      readonly given: string;
    }) => Effect.Effect<Option.Option<WorkImageId>>;
    /**
     * The image `id` names, read from the bot's workspace now: none when no
     * step names it, or its file is gone, has left the workspace, holds more
     * than `MAX_WORK_IMAGE_SIZE` bytes or is not a GIF, JPEG, PNG or WebP by
     * its content.
     */
    readonly open: (id: WorkImageId) => Effect.Effect<Option.Option<WorkImage>>;
  }
>()("@j3-bots/server/attachments/WorkImages") {}

export const layer = Layer.effect(
  WorkImages,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ids = yield* Ids;
    const readWorkspaceFile = yield* workspaceReader;

    const existing = SqlSchema.findOneOption({
      Request: Schema.Struct({ entryId: EntryId, stepId: Schema.String }),
      Result: Schema.Struct({ id: WorkImageId }),
      execute: ({ entryId, stepId }) => sql`
        SELECT id FROM work_images WHERE entry_id = ${entryId} AND step_id = ${stepId}
      `,
    });

    const rootOf = SqlSchema.findOneOption({
      Request: BotId,
      Result: Schema.Struct({ workspace_root: Schema.NullOr(Schema.String) }),
      execute: (botId) => sql`SELECT workspace_root FROM bots WHERE id = ${botId}`,
    });

    const imageRow = SqlSchema.findOneOption({
      Request: WorkImageId,
      Result: ImageRow,
      execute: (id) => sql`
        SELECT i.bot_id, i.path, b.workspace_root
        FROM work_images i JOIN bots b ON b.id = i.bot_id
        WHERE i.id = ${id}
      `,
    });

    /**
     * Where `given` is in the workspace whose real path, kept from
     * provisioning, is `root`: its real path relative to it, when that is
     * inside it and names an image by its extension. The harness may name the
     * file by a path that runs through a link, such as a home folder that is
     * one, so the path is resolved before it is compared.
     */
    const locate = Effect.fnUntraced(function* (root: string, given: string) {
      const extension = path.extname(given).slice(1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) return Option.none<string>();
      const real = yield* fs.realPath(path.resolve(root, given)).pipe(Effect.option);
      if (Option.isNone(real)) return Option.none<string>();
      const relative = path.relative(root, real.value);
      const [first] = relative.split(path.sep);
      return relative === "" || first === ".." || path.isAbsolute(relative)
        ? Option.none<string>()
        : Option.some(relative);
    });

    const record = Effect.fn("WorkImages.record")(function* (input: {
      readonly botId: BotId;
      readonly entryId: EntryId;
      readonly stepId: WorkStepId;
      readonly given: string;
    }) {
      const known = yield* existing({ entryId: input.entryId, stepId: input.stepId });
      if (Option.isSome(known)) return Option.some(known.value.id);
      const root = Option.flatMap(yield* rootOf(input.botId), (row) =>
        Option.fromNullishOr(row.workspace_root),
      );
      if (Option.isNone(root)) return Option.none<WorkImageId>();
      const relative = yield* locate(root.value, input.given);
      if (Option.isNone(relative)) return Option.none<WorkImageId>();
      const id = WorkImageId.make(yield* ids.make("wimg"));
      yield* sql`
        INSERT INTO work_images (id, entry_id, step_id, bot_id, path)
        VALUES (${id}, ${input.entryId}, ${input.stepId}, ${input.botId}, ${relative.value})
      `;
      return Option.some(id);
    }, Effect.orDie);

    const open = Effect.fn("WorkImages.open")(function* (id: WorkImageId) {
      const row = yield* imageRow(id).pipe(Effect.orDie);
      if (Option.isNone(row) || row.value.workspace_root === null) return Option.none<WorkImage>();
      const read = yield* readWorkspaceFile(
        row.value.workspace_root,
        row.value.path,
        MAX_WORK_IMAGE_SIZE,
      );
      if (read._tag !== "read") return Option.none<WorkImage>();
      const mediaType = imageTypeOf(read.bytes);
      return mediaType === undefined
        ? Option.none<WorkImage>()
        : Option.some({ bytes: read.bytes, mediaType });
    });

    return WorkImages.of({ record, open });
  }),
);
