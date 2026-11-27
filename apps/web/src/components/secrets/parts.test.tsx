// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderTestMarkup } from "../../app/testRoot";
import { describe, expect, it, vi } from "vite-plus/test";
import { SAMPLE_NOW, sampleTeam } from "../../gallery/sample";
import { AccessPicker } from "./parts";

vi.mock("../../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const NONE_YET = "There are no bots yet, so no bot can use it.";
const team = sampleTeam(SAMPLE_NOW);

describe("which bots may use a secret", () => {
  it("says no bot can use it while there is none to choose", () => {
    const markup = renderTestMarkup(
      <AccessPicker bots={[]} access={{ _tag: "bots", botIds: [] }} onChange={() => {}} />,
    );
    expect(markup).toContain(NONE_YET);
  });

  it("lists the bots to choose once there are some", () => {
    const markup = renderTestMarkup(
      <AccessPicker
        bots={[team.bots.moss]}
        access={{ _tag: "bots", botIds: [] }}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain(team.bots.moss.profile.name);
    expect(markup).not.toContain(NONE_YET);
  });
});
