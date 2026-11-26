// SPDX-License-Identifier: AGPL-3.0-or-later
import { NonNegativeInt } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// What `j3-bots export --report <file>` writes there once the archive is in
// place, for a program that runs the export: the desktop app, which tells the
// operator what stayed behind. The terminal gets the same in words.

/** What an export holds and what it left out. Never a secret's value. */
export const ExportReport = Schema.Struct({
  bots: NonNegativeInt,
  secrets: Schema.Union([
    Schema.TaggedStruct("none", {}),
    Schema.TaggedStruct("sealed", { records: NonNegativeInt }),
    /** Why they stayed behind: as `ArchivedSecrets` says it. */
    Schema.TaggedStruct("left-out", {
      reason: Schema.Literals(["old-vault", "unreadable", "newer"]),
    }),
  ]),
  /** Links in the bots' folders and the shared ones. */
  linksLeftOut: NonNegativeInt,
  /** Files left out under a name no import takes, by their path in the home. */
  namesLeftOut: Schema.Array(Schema.String),
  /** Attachments the database names whose bytes were already missing. */
  attachmentsMissing: NonNegativeInt,
});
export type ExportReport = typeof ExportReport.Type;

export const ExportReportJson = Schema.fromJsonString(Schema.toCodecJson(ExportReport));
