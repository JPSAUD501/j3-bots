// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { hear, heardText, nothingHeard, recognitionPlace } from "./recognition.ts";

describe("recognitionPlace", () => {
  it("runs on the device only when the language's model is installed there", () => {
    const installed = ["en-US", "pt-BR"];
    assert.strictEqual(recognitionPlace("pt-br", installed), "device");
    assert.strictEqual(recognitionPlace("pt-PT", installed), "online");
  });
});

describe("heardText", () => {
  it("keeps every finished utterance and follows the one still being heard", () => {
    let heard = hear(nothingHeard, "hello there", true);
    heard = hear(heard, "how", false);
    assert.strictEqual(heardText(heard), "hello there how");
    heard = hear(heard, "how are you ", false);
    assert.strictEqual(heardText(heard), "hello there how are you");
    heard = hear(heard, "how are you", true);
    heard = hear(heard, "", true);
    assert.strictEqual(heardText(heard), "hello there how are you");
  });
});
