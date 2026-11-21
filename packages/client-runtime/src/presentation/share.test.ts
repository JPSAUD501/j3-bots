// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AttachmentId,
  BotId,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_MESSAGE_LENGTH,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { Draft, DraftFile } from "../stores/Drafts.ts";
import { type Shared, sharedDraft, type SharedFile } from "./share.ts";

const shared = (given: Partial<Shared>): Shared => ({ text: null, url: null, files: [], ...given });

const photo = (name: string, size = 1, mediaType = "image/jpeg"): SharedFile => ({
  name,
  mediaType,
  size,
  uri: `content://media/fictional/${name}`,
});

const draft = (text: string, files: ReadonlyArray<DraftFile> = []): Draft => ({
  text,
  mentions: [],
  files,
  sending: false,
});

const uploaded = (id: string): DraftFile => ({
  _tag: "ready",
  key: id,
  attachment: {
    id: AttachmentId.make(id),
    name: `${id}.txt`,
    mediaType: "text/plain",
    size: 1,
  },
});

describe("sharedDraft", () => {
  it("puts the shared text in an empty draft, with its URL on a line of its own", () => {
    const article = "https://example.com/launch-notes";
    expect(sharedDraft(undefined, shared({ text: " Worth a read ", url: article })).text).toBe(
      `Worth a read\n${article}`,
    );
    expect(sharedDraft(undefined, shared({ url: article })).text).toBe(article);
    // A text that already holds the URL does not get it twice.
    expect(sharedDraft(undefined, shared({ text: `See ${article}`, url: article })).text).toBe(
      `See ${article}`,
    );
  });

  it("adds to what the draft holds, keeping its mentions where they stand", () => {
    const writing: Draft = {
      ...draft("@Scout have a look"),
      mentions: [{ _tag: "bot", botId: BotId.make("scout"), label: "Scout", position: 0 }],
    };
    const result = sharedDraft(writing, shared({ text: "The release notes" }));
    expect(result.text).toBe("@Scout have a look\n\nThe release notes");
    expect(result.mentions).toEqual(writing.mentions);
    // Files alone leave the writing as it was.
    expect(sharedDraft(writing, shared({ files: [photo("a.jpg")] })).text).toBe(writing.text);
    // A draft of blank space gives way to what was shared.
    expect(sharedDraft(draft("  \n"), shared({ text: "Notes" })).text).toBe("Notes");
  });

  it("keeps text over the message limit whole, for Send to refuse until it is shortened", () => {
    const long = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    expect(sharedDraft(draft("Read this:"), shared({ text: long })).text).toBe(
      `Read this:\n\n${long}`,
    );
  });

  it("uploads the files the draft takes and leaves out the rest with the composer's reasons", () => {
    // Room for two more files.
    const holding = draft("", [
      ...Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 2 }, (_, index) =>
        uploaded(`held-${index}`),
      ),
      // A file that could not go holds no place.
      { _tag: "failed", key: "refused", name: "big.bin", mediaType: "", size: 0, problem: "empty" },
    ]);
    const files = [
      photo("first.jpg"),
      photo("huge.mov", MAX_ATTACHMENT_SIZE + 1, "video/quicktime"),
      // Judged as the image the server will store it as.
      photo("large.png", MAX_INLINE_IMAGE_SIZE + 1, "IMAGE/PNG; name=large.png"),
      photo("second.jpg"),
      photo("third.jpg"),
    ];
    const result = sharedDraft(holding, shared({ files }));
    expect(result.uploads.map((file) => file.name)).toEqual(["first.jpg", "second.jpg"]);
    expect(result.leftOut.map(({ file, problem }) => [file.name, problem])).toEqual([
      ["huge.mov", "too-large"],
      ["large.png", "image-too-large"],
      ["third.jpg", "too-many"],
    ]);
  });
});
