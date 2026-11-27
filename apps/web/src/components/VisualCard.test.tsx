// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, VISUAL_FRAME_PATH } from "@j3-bots/contracts";
import { at, message } from "@j3-bots/client-runtime/testing";
import { buildTimeline } from "@j3-bots/client-runtime/presentation";
import { renderTestMarkup } from "../app/testRoot";
import { describe, expect, it, vi } from "vite-plus/test";
import { copySample, sampleSecrets } from "../gallery/sampleSecrets";
import { Timeline, type TimelineIntents } from "./Timeline";
import { ownFrameHeight } from "./VisualCard";

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const nothing = () => {};
const secrets = sampleSecrets({ state: "ready", now: () => at("2026-11-20T10:00:00Z") });
const intents: TimelineIntents = {
  answerQuestion: nothing,
  routineCard: nothing,
  dismissQuestion: nothing,
  decideApproval: nothing,
  provideSecret: nothing,
  declineSecret: nothing,
  answerBrowserHelp: nothing,
  openBrowser: nothing,
  declineSecretAsk: nothing,
  retryNotice: nothing,
  retryMessage: nothing,
  react: nothing,
  resendMessage: nothing,
  discardMessage: nothing,
  openWorkFold: nothing,
  closeWorkFold: nothing,
  openAttachment: nothing,
  openWorkImage: nothing,
  openRoutine: nothing,
  openConversation: nothing,
  signInConnector: nothing,
  answerConnectorInput: nothing,
  openConnectorPage: nothing,
  connectorAskSetup: () => Promise.resolve({ _tag: "failed", failure: { _tag: "unexpected" } }),
  allowConnectorAsk: nothing,
  declineConnectorAsk: nothing,
  connectorApp: {
    server: new URL("https://bots.example.com"),
    platform: "web",
    open: () => Promise.resolve(null),
    callTool: () => Promise.resolve(null),
    readResource: () => Promise.resolve(null),
    setContext: () => Promise.resolve(null),
    sendMessage: () => Promise.resolve(false),
    openLink: nothing,
    save: nothing,
  },
};

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;

/** The markup of a conversation holding one message from Scout that shows `page`. */
const shown = (page: string) =>
  renderTestMarkup(
    <Timeline
      rows={buildTimeline([
        message("2026-11-20T10:00:00Z", scout, "March was the peak.", {
          visual: { title: "Spending by month", html: page, height: 260 },
        }),
      ])}
      room={null}
      workSteps={() => null}
      submitting={() => false}
      intents={intents}
      secrets={{ view: secrets.view.get(), intents: { ...secrets, copy: copySample } }}
      onOpenPair={() => {}}
      onOpenRoom={() => {}}
      onOpenBot={() => {}}
      quotes={{ reveal: () => Promise.resolve("shown"), drafting: null }}
      recordScreen={null}
    />,
  );

describe("a bot's visual", () => {
  it("is drawn above its message in the sandboxed visual page, with scripts alone", () => {
    const html = shown("<svg></svg>");
    const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map((match) => match[0]);
    expect(frames).toHaveLength(1);
    const [frame = ""] = frames;
    expect(frame).toContain(`src="${VISUAL_FRAME_PATH}"`);
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).toContain('title="Spending by month"');
    expect(frame).not.toMatch(
      /srcdoc|allow-same-origin|allow-top-navigation|allow-popups|allow-forms/,
    );
    // The page is posted to the frame once it loads, never written into the markup.
    expect(html).not.toContain("<svg></svg>");
    expect(html.indexOf("Spending by month")).toBeLessThan(html.indexOf("March was the peak."));
    expect(html).toContain("height:260px");
  });

  it("that embeds another document is never framed, and says it could not be shown", () => {
    const html = shown("<svg></svg><iframe srcdoc='<p>'></iframe>");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Couldn’t show this visual.");
    expect(html).toContain("March was the peak.");
  });

  it("takes a height only from its own frame", () => {
    const own = {};
    const other = {};
    const report = { type: "j3-visual-height", height: 5000 };
    expect(ownFrameHeight({ source: own, data: report }, own)).toBe(2000);
    // Another visual's frame, the app's own window, or no sender: all are ignored.
    for (const source of [other, null, undefined]) {
      expect(ownFrameHeight({ source, data: report }, own)).toBeNull();
    }
    // A frame that has no window yet matches nothing, even a message with no sender.
    expect(ownFrameHeight({ source: null, data: report }, null)).toBeNull();
    expect(ownFrameHeight({ source: own, data: { type: "j3-visual-open" } }, own)).toBeNull();
  });
});
