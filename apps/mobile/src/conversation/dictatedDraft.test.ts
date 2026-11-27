// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { DraftMention } from "@j3-bots/client-runtime";
import { BotId } from "@j3-bots/contracts";
import { dictatedDraft, originOf } from "./dictatedDraft.ts";

const ana: DraftMention = { _tag: "bot", botId: BotId.make("ana"), label: "Ana", position: 9 };

describe("dictatedDraft", () => {
  it("puts the words at the caret and moves the mentions after it", () => {
    const origin = originOf({ text: "Ask then @Ana", mentions: [ana] }, [4, 4]);
    const draft = dictatedDraft(origin, { committed: "her", tentative: "now" });
    assert.strictEqual(draft.text, "Ask her now then @Ana");
    assert.deepStrictEqual(draft.mentions, [{ ...ana, position: 17 }]);
    assert.deepStrictEqual(draft.open, [7, 11]);
    assert.strictEqual(draft.caret, 11);
  });

  it("replaces the selection, and a mention in it, with what was heard", () => {
    const origin = originOf({ text: "Ask then @Ana", mentions: [ana] }, [9, 13]);
    const draft = dictatedDraft(origin, { committed: "everyone", tentative: "" });
    assert.strictEqual(draft.text, "Ask then everyone");
    assert.deepStrictEqual(draft.mentions, []);
    assert.strictEqual(draft.open, null);
  });
});
