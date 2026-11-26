// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { SAMPLE_NOW, sampleTeam } from "../gallery/sample";
import { type ConnectPlace, QuietConversation } from "./EmptyStates";

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const team = sampleTeam(SAMPLE_NOW);
const COMMAND = "j3-bots provider connect";
/** A new bot whose hello waits for a provider to be connected. */
const waiting = { ...team.bots.moss, opening: true } as const;
const signedOut = {
  ...team.engine,
  providers: team.engine.providers.map((provider) => ({
    ...provider,
    status: { _tag: "sign-in-required", command: COMMAND } as const,
  })),
};

const shown = (connect: ConnectPlace) =>
  renderToStaticMarkup(<QuietConversation bot={waiting} engine={signedOut} connect={connect} />);

describe("an empty conversation whose hello waits for a model", () => {
  it("gives the command to run where the server is", () => {
    const markup = shown({ _tag: "server" });
    expect(markup).toContain("run this on the machine where J3 Bots is installed");
    expect(markup).toContain(COMMAND);
  });

  it("sends a device that reaches the desktop app's server to the app, with no command", () => {
    const markup = shown({ _tag: "desktop-app" });
    expect(markup).toContain("sign in from Settings → Providers in J3 Bots");
    expect(markup).not.toContain(COMMAND);
  });
});
