// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderTestMarkup } from "../app/testRoot";
import { describe, expect, it, vi } from "vite-plus/test";
import { SAMPLE_NOW, sampleTeam } from "../gallery/sample";
import { sampleProviderActions } from "../gallery/sampleSource";
import { QuietConversation } from "./EmptyStates";

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const team = sampleTeam(SAMPLE_NOW);
/** A new bot whose hello has not been said yet. */
const waiting = { ...team.bots.moss, opening: true } as const;
const withClaude = (status: (typeof team.engine.providers)[number]["status"]) => ({
  ...team.engine,
  providers: team.engine.providers.map((provider) => ({ ...provider, status })),
});

const shown = (engine: ReturnType<typeof withClaude>) =>
  renderTestMarkup(
    <QuietConversation
      bot={waiting}
      engine={engine}
      connect={{ _tag: "server" }}
      actions={sampleProviderActions}
    />,
  );

describe("an empty conversation whose hello waits", () => {
  it("asks which AI the operator has while the bot's is not connected", () => {
    const markup = shown(
      withClaude({ _tag: "sign-in-required", command: "j3-bots provider connect" }),
    );
    expect(markup).toContain("says hello as soon as its AI is connected");
    expect(markup).toContain("Claude");
    expect(markup).toContain("ChatGPT");
  });

  it("offers no account while the wait is for a usage limit, which signing in does not lift", () => {
    const markup = shown(withClaude({ _tag: "limited", resetsAt: null }));
    expect(markup).toContain("says hello when the usage limit resets");
    expect(markup).not.toContain("ChatGPT");
  });
});
