// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { BotId, DeviceId } from "@j3-bots/contracts";
import type { Waiting } from "@j3-bots/desktop-bridge";
import { createI18n } from "@j3-bots/i18n";
import { trayModel } from "./trayModel.ts";

const pairing = DeviceId.make("device-1");
const waiting = (name: string): Waiting => ({
  target: { _tag: "conversation", botId: BotId.make(name.toLowerCase()) },
  name,
});

describe("the tray's menu", () => {
  it("says how many need the operator, names those it was given and counts the rest", () => {
    const model = trayModel(
      { pairing, count: 5, waiting: [waiting("Wren"), waiting("Scout")] },
      createI18n("en"),
    );
    assert.strictEqual(model.count, 5);
    assert.strictEqual(model.summary, "5 need you");
    assert.deepStrictEqual(
      model.entries.map((entry) => entry.label),
      ["Wren", "Scout"],
    );
    assert.strictEqual(model.more, "And 3 more");
    const one = trayModel({ pairing, count: 1, waiting: [waiting("Wren")] }, createI18n("pt-BR"));
    assert.strictEqual(one.summary, "1 precisa de você");
    assert.isNull(one.more);
  });
});
