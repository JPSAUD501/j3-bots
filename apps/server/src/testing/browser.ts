// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import { EngineTabId } from "@j3-bots/engine-t3";
import { TestBrowserControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import { engineSession } from "./turns.ts";

export { type FakeViewer, TestBrowserControl } from "@j3-bots/engine-t3/testing";
export { ViewerClosed } from "@j3-bots/engine-t3";

/**
 * The bot has these tabs open in the engine's browser, and no other: each
 * named by `id`, the last the newest, so its front tab.
 */
export const botHasTabs = (
  botId: BotId,
  tabs: ReadonlyArray<{ readonly id: string; readonly url: string; readonly title: string }>,
) =>
  Effect.gen(function* () {
    const sessionId = yield* engineSession(botId);
    const browser = yield* TestBrowserControl;
    yield* browser.setTabs(
      tabs.map((tab, index) => ({
        id: EngineTabId.make(tab.id),
        sessionId,
        url: tab.url,
        title: tab.title,
        loading: false,
        activeAt: index + 1,
      })),
    );
  });
