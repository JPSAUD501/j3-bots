// SPDX-License-Identifier: AGPL-3.0-or-later
import { AttachmentId, EntryId, MAX_MESSAGE_LENGTH, type MessageQuote } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { DraftFile } from "../stores/Drafts.ts";
import { draftReadiness } from "./draft.ts";

const ready: DraftFile = {
  _tag: "ready",
  key: "a",
  attachment: {
    id: AttachmentId.make("a"),
    name: "notes.pdf",
    mediaType: "application/pdf",
    size: 10,
  },
};
const uploading: DraftFile = {
  _tag: "uploading",
  key: "b",
  sent: 0,
  name: "photo.png",
  mediaType: "image/png",
  size: 10,
};
const refused: DraftFile = {
  _tag: "failed",
  key: "c",
  problem: "refused",
  name: "big.zip",
  mediaType: "application/zip",
  size: 10,
};

const quoted: MessageQuote = {
  entryId: EntryId.make("plans"),
  author: { _tag: "operator" },
  saidAt: DateTime.makeUnsafe("2026-11-20T12:00:00Z"),
  quoted: { _tag: "passage", text: "a quick one" },
};

describe("draft readiness", () => {
  it("has nothing to send in blank text alone, and something in an uploaded file", () => {
    expect(draftReadiness("  \n", [])).toMatchObject({ empty: true, sendable: false });
    expect(draftReadiness("  ", [ready])).toMatchObject({ empty: false, sendable: true });
  });

  it("sends a passage the operator commented without text, and not one quoted bare", () => {
    expect(draftReadiness("", [], [quoted])).toMatchObject({ empty: true, sendable: false });
    expect(draftReadiness("", [], [{ ...quoted, comment: "Too fast?" }])).toMatchObject({
      empty: false,
      sendable: true,
    });
  });

  it("holds the message while a file uploads, or until a refused file is removed", () => {
    expect(draftReadiness("Hi", [ready, uploading])).toMatchObject({
      uploading: true,
      sendable: false,
    });
    expect(draftReadiness("Hi", [ready, refused])).toMatchObject({
      blocked: true,
      sendable: false,
    });
  });

  it("does not send text over the message limit, and says why", () => {
    expect(draftReadiness("x".repeat(MAX_MESSAGE_LENGTH + 1), [])).toMatchObject({
      problem: "too-long",
      sendable: false,
    });
  });
});
