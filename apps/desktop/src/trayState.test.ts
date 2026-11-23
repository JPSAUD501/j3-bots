// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { BotId, DeviceId } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { makeTrayState, type TrayView } from "./trayState.ts";

/** A tray state over `en`, and the summary of each thing it drew. */
const drawing = () => {
  const summaries: Array<string> = [];
  const tray = makeTrayState({
    i18n: createI18n("en"),
    draw: (view: TrayView) => summaries.push(view.model.summary),
  });
  return { tray, summaries };
};

describe("the tray as the app feeds it", () => {
  it("says the bots on this computer restart, then what needs the operator once they run", () => {
    const { tray, summaries } = drawing();
    tray.report({
      pairing: DeviceId.make("device-1"),
      count: 1,
      waiting: [{ name: "Wren", target: { _tag: "conversation", botId: BotId.make("wren") } }],
    });
    tray.followLocalServer({ state: "ready", attempt: 1 });
    tray.followLocalServer({
      state: "restarting",
      attempt: 1,
      retryInSeconds: 4,
      reason: "The server stopped with exit code 1.",
    });
    tray.followLocalServer({ state: "starting", attempt: 2 });
    tray.followLocalServer({ state: "ready", attempt: 2 });
    assert.deepStrictEqual(summaries, [
      "Nothing needs you",
      "1 needs you",
      "1 needs you",
      "Bots stopped · restarting in 4 s",
      "Starting your bots…",
      "1 needs you",
    ]);
  });

  it("draws again only when what it shows changed", () => {
    const { tray, summaries } = drawing();
    tray.followLocalServer({ state: "failed", reason: "Port 3747 is in use." });
    tray.followLocalServer({ state: "failed", reason: "Port 3747 is in use." });
    tray.report({ pairing: null, count: 0, waiting: [] });
    assert.deepStrictEqual(summaries, ["Nothing needs you", "Bots couldn’t start"]);
  });

  it("goes back to the page's list when the app leaves local mode", () => {
    const { tray, summaries } = drawing();
    tray.followLocalServer({ state: "stopped" });
    tray.followLocalServer(null);
    assert.deepStrictEqual(summaries, ["Nothing needs you", "Bots stopped", "Nothing needs you"]);
  });
});
