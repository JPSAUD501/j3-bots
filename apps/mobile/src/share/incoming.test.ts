// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { sharedOf } from "./incoming.ts";
import type { Incoming } from "./native.ts";

const incoming = (given: Partial<Incoming>): Incoming => ({
  text: null,
  title: null,
  botId: null,
  files: [],
  unreadable: 0,
  beyond: 0,
  ...given,
});

const photo = {
  uri: "file:///data/fictional/cache/shares/1/0/beach.jpg",
  name: "beach.jpg",
  mediaType: "image/jpeg",
  size: 2048,
};

describe("sharedOf", () => {
  it("takes a web address shared alone as a link, named by the title its app gave", () => {
    expect(
      sharedOf(incoming({ text: " https://example.com/notes ", title: "Release notes" })),
    ).toEqual({
      text: null,
      url: "https://example.com/notes",
      title: "Release notes",
      files: [],
    });
  });

  it("takes any other text as it is, with the links in it and without a title", () => {
    expect(
      sharedOf(incoming({ text: "Look at https://example.com/notes", title: "Subject line" })),
    ).toEqual({ text: "Look at https://example.com/notes", url: null, title: null, files: [] });
  });

  it("takes the files the module copied, with or without text", () => {
    expect(sharedOf(incoming({ files: [photo] }))).toEqual({
      text: null,
      url: null,
      title: null,
      files: [photo],
    });
  });

  it("finds nothing to send in a share of blank text and no file", () => {
    expect(sharedOf(incoming({ text: "  \n" }))).toBeNull();
    expect(sharedOf(incoming({ unreadable: 2 }))).toBeNull();
  });
});
