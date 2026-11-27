// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_MESSAGE_LENGTH,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type Shared, type SharedFile, sharedMessage } from "./share.ts";

const shared = (given: Partial<Shared>): Shared => ({
  text: null,
  url: null,
  title: null,
  files: [],
  ...given,
});

const photo = (name: string, size = 1, mediaType = "image/jpeg"): SharedFile => ({
  name,
  mediaType,
  size,
  uri: `file:///data/fictional/shares/${name}`,
});

describe("sharedMessage", () => {
  const article = "https://example.com/launch-notes";

  it("sends the shared text, with its link on a line of its own", () => {
    expect(sharedMessage(shared({ text: " Worth a read ", url: article }), "").text).toBe(
      `Worth a read\n${article}`,
    );
    expect(sharedMessage(shared({ url: article }), "").text).toBe(article);
    // A text that already holds the link does not get it twice.
    expect(sharedMessage(shared({ text: `See ${article}`, url: article }), "").text).toBe(
      `See ${article}`,
    );
  });

  it("names a link by the title the sharing app gave it", () => {
    expect(sharedMessage(shared({ url: article, title: "Launch notes" }), "").text).toBe(
      `Launch notes\n${article}`,
    );
    // A title the text already says, or one that is the link itself, is not said again.
    expect(
      sharedMessage(shared({ text: "Launch notes", url: article, title: "Launch notes" }), "").text,
    ).toBe(`Launch notes\n${article}`);
    expect(sharedMessage(shared({ url: article, title: article }), "").text).toBe(article);
  });

  it("puts the operator's line first, apart from what was shared", () => {
    expect(sharedMessage(shared({ url: article }), "  Is this the one?  ").text).toBe(
      `Is this the one?\n\n${article}`,
    );
    expect(sharedMessage(shared({ files: [photo("a.jpg")] }), "Receipt").text).toBe("Receipt");
    expect(sharedMessage(shared({ files: [photo("a.jpg")] }), "  ").text).toBe("");
  });

  it("keeps text over the message limit whole, for the send to refuse", () => {
    const long = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    expect(sharedMessage(shared({ text: long }), "Read this:").text).toBe(`Read this:\n\n${long}`);
  });

  it("uploads the files a message takes and leaves out the rest with the composer's reasons", () => {
    const files = [
      photo("first.jpg"),
      photo("huge.mov", MAX_ATTACHMENT_SIZE + 1, "video/quicktime"),
      // Judged as the image the server will store it as.
      photo("large.png", MAX_INLINE_IMAGE_SIZE + 1, "IMAGE/PNG; name=large.png"),
      photo("empty.txt", 0, "text/plain"),
      ...Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => photo(`${index}.jpg`)),
    ];
    const result = sharedMessage(shared({ files }), "");
    expect(result.uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result.uploads[0]?.name).toBe("first.jpg");
    expect(result.leftOut.map(({ file, problem }) => [file.name, problem])).toEqual([
      ["huge.mov", "too-large"],
      ["large.png", "image-too-large"],
      ["empty.txt", "empty"],
      [`${MAX_ATTACHMENTS_PER_MESSAGE - 1}.jpg`, "too-many"],
    ]);
  });
});
