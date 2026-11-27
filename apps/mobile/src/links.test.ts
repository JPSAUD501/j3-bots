// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoutineId } from "@j3-bots/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type AppLink, appLink, appLinkOf } from "./links.ts";

vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));

const SCHEME = "j3bots-dev";

describe("app links", () => {
  it("open what they were made for, whatever the ids hold", () => {
    const links: ReadonlyArray<AppLink> = [
      { _tag: "bot", botId: BotId.make("scout") },
      { _tag: "bot", botId: BotId.make("a/b c?d#e") },
      { _tag: "routine", botId: BotId.make("scout"), routineId: RoutineId.make("morning/news") },
    ];
    for (const link of links) expect(appLinkOf(SCHEME, appLink(SCHEME, link))).toEqual(link);
  });

  it("open nothing from another scheme, another path or a malformed link", () => {
    const bot = appLink(SCHEME, { _tag: "bot", botId: BotId.make("scout") });
    expect(appLinkOf("j3bots", bot)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://pair?code=ABCDE`)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://open/bot/`)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://open/bot/scout/extra`)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://open/routine/scout`)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://open/bot/%E0%A4%A`)).toBeNull();
    expect(appLinkOf(SCHEME, `${SCHEME}://open/room/lobby`)).toBeNull();
  });
});
