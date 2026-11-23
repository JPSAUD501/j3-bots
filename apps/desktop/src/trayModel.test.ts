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
      null,
      createI18n("en"),
    );
    assert.strictEqual(model.count, 5);
    assert.strictEqual(model.summary, "5 need you");
    assert.deepStrictEqual(
      model.entries.map((entry) => entry.label),
      ["Wren", "Scout"],
    );
    assert.strictEqual(model.more, "And 3 more");
    const one = trayModel(
      { pairing, count: 1, waiting: [waiting("Wren")] },
      null,
      createI18n("pt-BR"),
    );
    assert.strictEqual(one.summary, "1 precisa de você");
    assert.isNull(one.more);
  });

  it("says first that the bots on this computer are not running, while they are not", () => {
    const report = { pairing, count: 1, waiting: [waiting("Wren")] };
    const en = createI18n("en");
    const pt = createI18n("pt-BR");
    const summary = (local: Parameters<typeof trayModel>[1], i18n = en) =>
      trayModel(report, local, i18n).summary;
    assert.strictEqual(summary({ state: "ready" }), "1 needs you");
    assert.strictEqual(summary({ state: "starting" }), "Starting your bots…");
    assert.strictEqual(
      summary({ state: "starting", update: { _tag: "updating", from: "0.3.0", to: "0.3.1" } }),
      "Updating your bots…",
    );
    assert.strictEqual(summary({ state: "stopped" }), "Bots stopped");
    assert.strictEqual(
      summary({ state: "restarting", attempt: 2, retryInSeconds: 4 }),
      "Bots stopped · restarting in 4 s",
    );
    assert.strictEqual(summary({ state: "restarting", attempt: 3 }), "Bots stopped · restarting…");
    assert.strictEqual(
      summary({ state: "failed", reason: "Port 3747 is in use." }),
      "Bots couldn’t start",
    );
    assert.strictEqual(summary({ state: "stopped" }, pt), "Bots parados");
    assert.strictEqual(
      summary({ state: "restarting", attempt: 2, retryInSeconds: 4 }, pt),
      "Bots parados · reiniciando em 4 s",
    );
    assert.strictEqual(summary({ state: "failed" }, pt), "Os bots não iniciaram");
    // What waits is still listed, under the line that says the bots are not running.
    assert.deepStrictEqual(
      trayModel(report, { state: "stopped" }, en).entries.map((entry) => entry.label),
      ["Wren"],
    );
  });
});
