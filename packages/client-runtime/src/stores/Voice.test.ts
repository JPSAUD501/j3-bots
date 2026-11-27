// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { type DictationState, nextState } from "./Voice.ts";

describe("nextState", () => {
  it("follows a dictation from the download to its words, and keeps them while it finishes", () => {
    const frames = [
      { type: "installing", received: 0, total: 751 },
      { type: "installing", received: 400, total: 751 },
      { type: "listening", live: true },
      { type: "words", committed: "", tentative: "olá" },
      { type: "words", committed: "olá", tentative: "Wren" },
    ] as const;
    const seen: Array<DictationState> = [];
    let state: DictationState = { _tag: "connecting" };
    for (const frame of frames) {
      state = nextState(state, frame);
      seen.push(state);
    }
    expect(seen[1]).toEqual({ _tag: "installing", received: 400, total: 751 });
    expect(state).toEqual({ _tag: "listening", live: true, committed: "olá", tentative: "Wren" });

    // The operator stopped: the last words still come, then the AI's tidy-up, then the text.
    let finishing: DictationState = { _tag: "finishing", committed: "olá", tentative: "Wren" };
    finishing = nextState(finishing, { type: "words", committed: "olá Wren", tentative: "" });
    expect(finishing).toEqual({ _tag: "finishing", committed: "olá Wren", tentative: "" });
    const tidying = nextState(finishing, { type: "tidying" });
    expect(tidying).toEqual({ _tag: "tidying", committed: "olá Wren", tentative: "" });
    expect(nextState(tidying, { type: "done", text: "Olá, Wren." })).toEqual({
      _tag: "done",
      text: "Olá, Wren.",
    });
  });

  it("ends on the server's reason, and on unknown for one this client does not know", () => {
    const listening: DictationState = {
      _tag: "listening",
      live: false,
      committed: "",
      tentative: "",
    };
    expect(nextState(listening, { type: "failed", reason: "busy" })).toEqual({
      _tag: "failed",
      reason: "busy",
    });
    expect(nextState(listening, { type: "failed", reason: "unknown" })).toEqual({
      _tag: "failed",
      reason: "unknown",
    });
  });
});
