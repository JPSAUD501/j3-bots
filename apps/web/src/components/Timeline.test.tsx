// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, EntryOrder } from "@j3-bots/contracts";
import { at, message } from "@j3-bots/client-runtime/testing";
import { buildTimeline } from "@j3-bots/client-runtime/presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { sampleVault } from "../gallery/sampleVault";
import { Timeline, type TimelineIntents } from "./Timeline";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const nothing = () => {};
const vault = sampleVault({ state: "locked", now: () => at("2026-11-20T10:00:00Z") });
const intents: TimelineIntents = {
  answerQuestion: nothing,
  dismissQuestion: nothing,
  decideApproval: nothing,
  provideSecret: nothing,
  declineSecret: nothing,
  answerBrowserHelp: nothing,
  openBrowser: nothing,
  dismissLogin: nothing,
  retryNotice: nothing,
  retryMessage: nothing,
  resendMessage: nothing,
  discardMessage: nothing,
  openWorkFold: nothing,
  closeWorkFold: nothing,
  openAttachment: nothing,
  openRoutine: nothing,
  openConversation: nothing,
  connectSuggested: nothing,
  dismissSuggestion: nothing,
  signInConnector: nothing,
};

describe("a conversation", () => {
  it("shows an entry of a kind added after this version as a line, between the others", () => {
    const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
    const html = renderToStaticMarkup(
      <Timeline
        rows={buildTimeline([
          message("2026-11-20T10:00:00Z", scout, "Before"),
          {
            _tag: "unknown",
            kind: "poll",
            id: EntryId.make("later"),
            order: EntryOrder.make(100),
            createdAt: at("2026-11-20T10:00:10Z"),
          },
          message("2026-11-20T10:00:20Z", scout, "After"),
        ])}
        room={null}
        workSteps={() => null}
        submitting={() => false}
        intents={intents}
        vault={{ view: vault.view.get(), intents: vault }}
        onOpenPair={() => {}}
        onOpenRoom={() => {}}
      />,
    );
    const before = html.indexOf("Before");
    const line = html.indexOf("This needs a newer version of the app.");
    const after = html.indexOf("After");
    expect([before, line, after].every((index) => index >= 0)).toBe(true);
    expect(before < line && line < after).toBe(true);
    expect(html).toContain('data-seen-id="later"');
  });
});
