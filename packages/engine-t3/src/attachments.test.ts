// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { normalizeAttachmentMetadata } from "./attachments.ts";

describe("normalizeAttachmentMetadata", () => {
  it("puts a file's name and media type in the form the engine stages", () => {
    assert.deepStrictEqual(
      normalizeAttachmentMetadata({
        name: "  report.pdf ",
        mediaType: " Text/Plain; charset=UTF-8",
      }),
      { name: "report.pdf", mediaType: "text/plain" },
    );
  });

  it("refuses what the engine's upload would refuse", () => {
    assert.isUndefined(normalizeAttachmentMetadata({ name: "   ", mediaType: "text/plain" }));
    assert.isUndefined(
      normalizeAttachmentMetadata({ name: "a".repeat(256), mediaType: "text/plain" }),
    );
    assert.isUndefined(normalizeAttachmentMetadata({ name: "a", mediaType: "plain" }));
    assert.isUndefined(
      normalizeAttachmentMetadata({ name: "a", mediaType: `text/${"x".repeat(96)}` }),
    );
  });
});
