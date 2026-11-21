// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";
import { carriesFiles, sharedOf } from "./shared.ts";

const COPY = "file:///cache/IMG_0001.jpg";

const photo: SharePayload = {
  value: "content://media/external/images/media/1",
  shareType: "image",
  mimeType: "image/jpeg",
};

const resolvedPhoto: ResolvedSharePayload = {
  ...photo,
  contentUri: COPY,
  contentType: "image",
  contentMimeType: "image/jpeg",
  originalName: "IMG_0001.jpg",
  // What the sending app reported, not what was copied.
  contentSize: 1,
};

const sizes = new Map([[COPY, 2048]]);
const sizeOf = (uri: string) => sizes.get(uri) ?? 0;

describe("sharedOf", () => {
  it("reads a shared photo from the copy in the app's storage", () => {
    assert.isTrue(carriesFiles([photo]));
    assert.deepStrictEqual(sharedOf([photo], [resolvedPhoto], sizeOf), {
      text: null,
      url: null,
      files: [{ name: "IMG_0001.jpg", mediaType: "image/jpeg", size: 2048, uri: COPY }],
    });
  });

  it("takes a shared link as the link, without resolving it", () => {
    const link: SharePayload = {
      value: "https://example.com/a",
      shareType: "url",
      mimeType: "text/plain",
    };
    assert.isFalse(carriesFiles([link]));
    assert.deepStrictEqual(sharedOf([link], [], sizeOf), {
      text: null,
      url: "https://example.com/a",
      files: [],
    });
  });

  it("finds nothing for the draft in blank text", () => {
    const blank: SharePayload = { value: "  ", shareType: "text", mimeType: "text/plain" };
    assert.isNull(sharedOf([blank], [], sizeOf));
  });
});
