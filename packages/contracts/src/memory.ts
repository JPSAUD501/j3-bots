import * as Schema from "effect/Schema";
import { BotId, NonNegativeInt } from "./base.ts";

/** One bot's memory, or the facts about the operator every bot can read. */
export const MemoryScope = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("shared", {}),
]);
export type MemoryScope = typeof MemoryScope.Type;

/**
 * A Markdown file relative to the scope's memory folder, such as `profile.md` or
 * `log/2026-11.md`. The server refuses paths that leave the folder.
 */
export const MemoryPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\w.-]+(?:\/[\w.-]+)*\.md$/),
).pipe(Schema.brand("MemoryPath"));
export type MemoryPath = typeof MemoryPath.Type;

/** Changes whenever the file changes, by anyone. Writes must name the one they read. */
export const MemoryRevision = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("MemoryRevision"));
export type MemoryRevision = typeof MemoryRevision.Type;

export const MemoryText = Schema.String.check(Schema.isMaxLength(200_000));

export const MemoryFile = Schema.Struct({
  path: MemoryPath,
  /** Bytes. */
  size: NonNegativeInt,
  updatedAt: Schema.DateTimeUtc,
});
export type MemoryFile = typeof MemoryFile.Type;

export const MemoryDocument = Schema.Struct({
  path: MemoryPath,
  text: MemoryText,
  revision: MemoryRevision,
});
export type MemoryDocument = typeof MemoryDocument.Type;
