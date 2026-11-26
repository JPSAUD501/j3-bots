// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Skill } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { bot } from "../../test/fixtures.ts";
import { skillGroups } from "./skills.ts";

const scout = bot("Scout");
const ana = bot("Ana");

const skill = (name: string, scope: Skill["scope"], shipped = false): Skill => ({
  name,
  scope,
  description: `When ${name}`,
  files: 0,
  shipped,
  source: null,
  lastChange: null,
});

describe("skillGroups", () => {
  it("lists every bot's, then each bot's that has any, by name, and none of J3 Bots' own", () => {
    const groups = skillGroups(
      [
        skill("review", { _tag: "bot", botId: ana.id }),
        skill("j3-routines", { _tag: "all-bots" }, true),
        skill("weekly", { _tag: "all-bots" }),
        skill("notes", { _tag: "all-bots" }),
      ],
      [scout, ana],
    );
    expect(groups.map((group) => [group.scope, group.skills.map(({ name }) => name)])).toEqual([
      [{ _tag: "all-bots" }, ["notes", "weekly"]],
      [{ _tag: "bot", botId: ana.id }, ["review"]],
    ]);
  });

  it("is empty when every skill is J3 Bots' own", () => {
    expect(skillGroups([skill("j3-app", { _tag: "all-bots" }, true)], [scout, ana])).toEqual([]);
  });
});
