// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { hear, heardWords, nothingHeard, recognizerLocale } from "./recognition.ts";

describe("recognizerLocale", () => {
  it("hears the phone's own language, in the locale the phone is set to", () => {
    const installed = ["en-US", "pt-PT", "pt-BR"];
    assert.strictEqual(recognizerLocale("auto", ["pt-BR", "en-US"], installed), "pt-BR");
    assert.strictEqual(recognizerLocale("auto", ["en-GB"], installed), "en-US");
    assert.strictEqual(recognizerLocale("en", ["pt-BR"], installed), "en-US");
  });

  it("finds nothing when the language is not installed on the phone", () => {
    assert.strictEqual(recognizerLocale("auto", ["es-ES"], ["en-US"]), null);
    assert.strictEqual(recognizerLocale("pt", ["pt-BR"], []), null);
    assert.strictEqual(recognizerLocale("auto", [], ["en-US"]), null);
  });
});

describe("heardWords", () => {
  it("settles every finished utterance and leaves the one still heard open", () => {
    let heard = hear(nothingHeard, "hello there", true);
    heard = hear(heard, "how", false);
    assert.deepStrictEqual(heardWords(heard), { committed: "hello there", tentative: "how" });
    heard = hear(heard, "how are you ", false);
    heard = hear(heard, "how are you", true);
    heard = hear(heard, "", true);
    assert.deepStrictEqual(heardWords(heard), {
      committed: "hello there how are you",
      tentative: "",
    });
  });
});
