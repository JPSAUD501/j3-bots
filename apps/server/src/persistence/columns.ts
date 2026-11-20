// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

// How the database's columns map to the domain's types. Rows are decoded with
// these schemas like any other data that crosses a boundary.

/** An ISO-8601 UTC time, as every `*_at` column stores it. */
export const Time = Schema.DateTimeUtcFromString;

/** A SQLite boolean: 0 or 1. */
export const Flag = Schema.BooleanFromBit;

/** A `*_json` column holding `schema`'s JSON form. */
export const json = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

/** The text a time column stores. */
export const timeText = (at: DateTime.Utc): string => DateTime.formatIso(at);
