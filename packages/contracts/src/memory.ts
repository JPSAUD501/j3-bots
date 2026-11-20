// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * `log/2026-11.md`. Every segment starts with a letter, digit or underscore, so
 * `.` and `..` cannot appear and no path can leave the folder or name a hidden
 * file. Every segment is ASCII and at most 255 characters, so any file system
 * takes it as a name. The server still checks that the resolved path is inside
 * the folder.
 */
export const MemoryPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:\w[\w.-]{0,254}\/)*\w[\w.-]{0,251}\.md$/),
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
