// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Draft } from "@j3-bots/client-runtime";
import { describe, expect, it } from "vite-plus/test";
import { savesUnderWay } from "./savesUnderWay";

const idle: Parameters<typeof savesUnderWay>[0] = {
  settings: { profile: { _tag: "idle" }, notifications: { _tag: "idle" } },
  bots: new Map(),
  memory: new Map(),
  actions: new Map(),
  drafts: new Map(),
  draftsNotSaved: new Set(),
};

const draft = (change: Partial<Draft>): Draft => ({
  text: "Hello",
  mentions: [],
  files: [],
  sending: false,
  ...change,
});

describe("a save under way, which a restart into an update waits for", () => {
  it("is none when nothing is waiting for the server or the device", () => {
    expect(savesUnderWay(idle)).toBe(false);
    // A draft the device kept, and a settings save that ended, are done.
    expect(
      savesUnderWay({
        ...idle,
        settings: { ...idle.settings, profile: { _tag: "saved", changes: {} } },
        drafts: new Map([["bot:b1", draft({})]]),
      }),
    ).toBe(false);
  });

  it("is a write the server has not answered", () => {
    expect(
      savesUnderWay({
        ...idle,
        settings: { ...idle.settings, notifications: { _tag: "saving", changes: {} } },
      }),
    ).toBe(true);
    expect(
      savesUnderWay({ ...idle, memory: new Map([["m", { _tag: "saving", changes: {} }]]) }),
    ).toBe(true);
    expect(
      savesUnderWay({ ...idle, actions: new Map([["card:e1", { _tag: "submitting" }]]) }),
    ).toBe(true);
  });

  it("is what the device has not kept: a draft, a send to the outbox, a file uploading", () => {
    expect(savesUnderWay({ ...idle, draftsNotSaved: new Set(["bot:b1"]) })).toBe(true);
    expect(
      savesUnderWay({ ...idle, drafts: new Map([["bot:b1", draft({ sending: true })]]) }),
    ).toBe(true);
    const uploading = draft({
      files: [
        {
          _tag: "uploading",
          key: "f1",
          sent: 10,
          name: "notes.txt",
          mediaType: "text/plain",
          size: 20,
        },
      ],
    });
    expect(savesUnderWay({ ...idle, drafts: new Map([["bot:b1", uploading]]) })).toBe(true);
  });
});
