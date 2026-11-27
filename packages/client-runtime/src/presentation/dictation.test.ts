// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import type { VoiceSettings } from "@j3-bots/contracts";
import { dictationPath, followTyping, levelOf, placeHeard } from "./dictation.ts";

const voice: VoiceSettings = {
  place: "automatic",
  provider: "openai",
  language: "auto",
  words: [],
  removeFillers: true,
  cleanUp: false,
  model: null,
  openRouterModel: null,
};
const keys = { openai: true, xai: false, openrouter: false };

describe("dictationPath", () => {
  it("uses the phone's own recognizer on Automatic when it has the language, else the provider", () => {
    const automatic = { voice, keys, secureContext: true } as const;
    expect(dictationPath({ ...automatic, device: "ready" })).toEqual({ _tag: "device" });
    expect(dictationPath({ ...automatic, device: "missing-language" })).toEqual({ _tag: "server" });
    expect(dictationPath({ ...automatic, device: "none" })).toEqual({ _tag: "server" });
  });

  it("sends the phone's voice to the provider too when the place is that provider", () => {
    expect(
      dictationPath({
        voice: { ...voice, place: "openai" },
        keys,
        device: "ready",
        secureContext: true,
      }),
    ).toEqual({ _tag: "server" });
  });

  it("offers only the device's own recognizer facing a server before cloud dictation", () => {
    const { provider: _, ...older } = voice;
    for (const settings of [null, older]) {
      const base = { voice: settings, keys: null, secureContext: true } as const;
      expect(dictationPath({ ...base, device: "ready" })).toEqual({ _tag: "device" });
      expect(dictationPath({ ...base, device: "none" })).toEqual({ _tag: "none" });
    }
  });

  it("explains a page over plain http, where a browser gives no microphone", () => {
    expect(dictationPath({ voice, keys, device: "none", secureContext: false })).toEqual({
      _tag: "blocked",
      block: "insecure-page",
    });
  });

  it("asks for set-up until a provider, its key and OpenRouter's model are there", () => {
    const base = { keys, device: "none", secureContext: true } as const;
    const setup = { _tag: "blocked", block: "setup" } as const;
    expect(dictationPath({ ...base, voice: { ...voice, provider: null } })).toEqual(setup);
    expect(dictationPath({ ...base, voice: { ...voice, provider: "xai" } })).toEqual(setup);
    const openRouter = { ...voice, provider: "openrouter" } as const;
    const withKey = { ...keys, openrouter: true };
    expect(dictationPath({ ...base, keys: withKey, voice: openRouter })).toEqual(setup);
    expect(
      dictationPath({
        ...base,
        keys: withKey,
        voice: { ...openRouter, openRouterModel: "openai/whisper" },
      }),
    ).toEqual({ _tag: "server" });
    // While the keys are not known yet, the server says if one is missing.
    expect(dictationPath({ ...base, keys: null, voice: { ...voice, provider: "xai" } })).toEqual({
      _tag: "server",
    });
  });

  it("says a device without its own recognizer cannot dictate when the choice is to stay on it", () => {
    expect(
      dictationPath({
        voice: { ...voice, place: "device" },
        keys,
        device: "none",
        secureContext: true,
      }),
    ).toEqual({ _tag: "blocked", block: "no-device-recognizer" });
  });
});

describe("followTyping", () => {
  const at = { start: 6, end: 6 };
  it("moves with what is typed before the words' place, and stays for what is typed after", () => {
    expect(followTyping(at, "Hello world", "Oh, Hello world")).toEqual({ start: 10, end: 10 });
    expect(followTyping(at, "Hello world", "Hello world!")).toEqual(at);
    // Typed right at the place: the words come after what was typed.
    expect(followTyping(at, "Hello world", "Hello big world")).toEqual({ start: 10, end: 10 });
  });

  it("goes to the end of an edit that ran over the words' place", () => {
    expect(followTyping({ start: 6, end: 11 }, "Hello world", "Hello there")).toEqual({
      start: 11,
      end: 11,
    });
    expect(followTyping(at, "Hello world", "Hi")).toEqual({ start: 2, end: 2 });
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
