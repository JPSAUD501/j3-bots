// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
} from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import { admitFiles, type LocalFile, normalizeMediaType } from "../src/files/limits.ts";

const file = (size: number, mediaType = "text/plain", name = "notes.txt"): LocalFile => ({
  name,
  mediaType,
  size,
});

describe("admitFiles", () => {
  it("admits files within the limits and names each one that is not", () => {
    assert.deepStrictEqual(
      admitFiles(
        [],
        [
          file(1),
          file(0),
          file(MAX_ATTACHMENT_SIZE + 1),
          file(1, "text/plain", "n".repeat(MAX_ATTACHMENT_NAME_LENGTH + 1)),
        ],
      ),
      [null, "empty", "too-large", "name-too-long"],
    );
  });

  it("holds inline images to their own limits, and other files of the same size to none", () => {
    const size = MAX_INLINE_IMAGE_SIZE + 1;
    assert.deepStrictEqual(
      admitFiles([], [file(size, "image/png"), file(size, "application/pdf")]),
      ["image-too-large", null],
    );
    const image = file(MAX_INLINE_IMAGE_SIZE, "image/jpeg");
    const fit = Math.floor(MAX_INLINE_IMAGES_SIZE / MAX_INLINE_IMAGE_SIZE);
    const held = Array.from({ length: fit - 1 }, () => image);
    assert.deepStrictEqual(admitFiles(held, [image, image]), [null, "images-too-large"]);
  });

  it("counts the files already held, and not the ones refused", () => {
    const held = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 1 }, () => file(1));
    assert.deepStrictEqual(admitFiles(held, [file(0), file(1), file(1)]), [
      "empty",
      null,
      "too-many",
    ]);
  });
});

describe("normalizeMediaType", () => {
  it("keeps what the server stores, and falls back for what it would refuse", () => {
    assert.strictEqual(normalizeMediaType("Text/Plain; charset=utf-8"), "text/plain");
    assert.strictEqual(normalizeMediaType(""), "application/octet-stream");
    assert.strictEqual(normalizeMediaType("not a type"), "application/octet-stream");
  });
});
