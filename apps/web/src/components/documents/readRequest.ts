// SPDX-License-Identifier: AGPL-3.0-or-later
import { DocumentRead, type ReadKind } from "@j3-bots/client-runtime/documents";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Request = Schema.Struct({
  kind: Schema.Literals(["text", "markdown", "csv", "tsv", "sheet", "word", "slides"]),
  bytes: Schema.Uint8Array,
  locale: Schema.String,
});

/** What the page asks the reading worker, decoded on the worker's side. */
export const ReadRequest = {
  make: (kind: ReadKind, bytes: Uint8Array, locale: string) => ({ kind, bytes, locale }),
  decode: (data: unknown) => Option.getOrNull(Schema.decodeUnknownOption(Request)(data)),
};

/** What the worker answers, decoded on the page's side: anything else is unreadable. */
export const decodeRead = (data: unknown): DocumentRead =>
  Option.getOrElse(Schema.decodeUnknownOption(DocumentRead)(data), (): DocumentRead => ({
    _tag: "unreadable",
  }));
