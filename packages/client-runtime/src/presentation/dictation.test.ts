// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { VoiceModelId, type VoiceStatus } from "@j3-bots/contracts";
import { dictationPath, levelOf, placeHeard } from "./dictation.ts";

const available: VoiceStatus = {
  _tag: "available",
  model: {
    id: VoiceModelId.make("m"),
    name: "M",
    size: 1,
    languages: ["en"],
    live: true,
    errorPercent: {},
    secondsPer30s: null,
    recommended: true,
    installed: true,
  },
  installing: null,
};

describe("dictationPath", () => {
  it("uses the phone's own recognizer on Automatic when it has the language, else the server", () => {
    const automatic = { place: "automatic", status: available, secureContext: true } as const;
    expect(dictationPath({ ...automatic, device: "ready" })).toEqual({ _tag: "device" });
    expect(dictationPath({ ...automatic, device: "missing-language" })).toEqual({ _tag: "server" });
    expect(dictationPath({ ...automatic, device: "none" })).toEqual({ _tag: "server" });
  });

  it("offers only what an older server allows: the device's own recognizer, or no microphone", () => {
    const older = { place: null, status: null, secureContext: true } as const;
    expect(dictationPath({ ...older, device: "ready" })).toEqual({ _tag: "device" });
    expect(dictationPath({ ...older, device: "missing-language" })).toEqual({ _tag: "none" });
    expect(dictationPath({ ...older, device: "none" })).toEqual({ _tag: "none" });
  });

  it("explains a page over plain http, where a browser gives no microphone", () => {
    expect(
      dictationPath({ place: "server", device: "none", status: available, secureContext: false }),
    ).toEqual({ _tag: "blocked", block: "insecure-page" });
  });

  it("says why when the choice cannot be served", () => {
    const base = { secureContext: true, status: available } as const;
    expect(dictationPath({ ...base, place: "device", device: "none" })).toEqual({
      _tag: "blocked",
      block: "no-device-recognizer",
    });
    const unsupported = { _tag: "unavailable", reason: "platform" } as const;
    expect(
      dictationPath({ ...base, place: "server", device: "none", status: unsupported }),
    ).toEqual({ _tag: "blocked", block: "server-unsupported" });
    // A cloud provider does not need a model the server runs.
    expect(
      dictationPath({ ...base, place: "openai", device: "none", status: unsupported }),
    ).toEqual({ _tag: "server" });
    expect(
      dictationPath({
        ...base,
        place: "openai",
        device: "none",
        status: { _tag: "unavailable", reason: "engine" },
      }),
    ).toEqual({ _tag: "blocked", block: "server-unavailable" });
  });
});

describe("placeHeard", () => {
  it("puts the words at the caret, spaced from the words around them, settled before open", () => {
    const draft = { text: "Ask Wren about tomorrow", start: 14, end: 14 };
    const placed = placeHeard(draft, { committed: "the photo", tentative: "for" });
    expect(placed.text).toBe("Ask Wren about the photo for tomorrow");
    expect(placed.text.slice(placed.from, placed.committed)).toBe("the photo");
    expect(placed.text.slice(placed.committed, placed.tentative)).toBe(" for");
  });

  it("replaces the selection, and takes no space before punctuation", () => {
    const placed = placeHeard(
      { text: "Hello there.", start: 6, end: 11 },
      { committed: "world", tentative: "" },
    );
    expect(placed.text).toBe("Hello world.");
    expect(placed.tentative).toBe(11);
  });

  it("leaves the draft as it was while nothing was heard", () => {
    const placed = placeHeard({ text: "Hi ", start: 3, end: 3 }, { committed: "", tentative: "" });
    expect(placed).toEqual({ text: "Hi ", from: 3, committed: 3, tentative: 3 });
  });
});

describe("levelOf", () => {
  it("shows silence as nothing and a loud voice near the top", () => {
    expect(levelOf(new Float32Array(160))).toBe(0);
    expect(levelOf(new Float32Array(160).fill(0.5))).toBeGreaterThan(0.8);
    expect(levelOf(new Float32Array(160).fill(0.0005))).toBe(0);
  });
});
