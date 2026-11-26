// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Skill } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { bot } from "../../test/fixtures.ts";
import { installedName, skillGroups, skillInstall } from "./skills.ts";

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
  it("lists every bot's first, then each bot's that has any, J3 Bots' own last in a scope", () => {
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
      [{ _tag: "all-bots" }, ["notes", "weekly", "j3-routines"]],
      [{ _tag: "bot", botId: ana.id }, ["review"]],
    ]);
  });
});

describe("skillInstall", () => {
  const draft = {
    scope: { _tag: "all-bots" },
    repository: "https://git.example.com/team/skills.git",
    path: "/skills/Triage/",
    ref: "main",
    name: "",
  } as const;

  it("takes the folder's name, lower-cased, and trims the folder's slashes", () => {
    expect(skillInstall(draft)).toEqual({
      _tag: "valid",
      install: { ...draft, path: "skills/Triage", name: "triage" },
    });
  });

  it("names every field that does not hold", () => {
    expect(
      skillInstall({
        ...draft,
        repository: "http://git.example.com/skills.git",
        path: "a/../b",
        ref: "-bad",
      }),
    ).toEqual({ _tag: "invalid", problems: ["repository", "path", "ref"] });
  });

  it("takes the repository's name for its root", () => {
    expect(installedName("https://git.example.com/team/Skills.git", "")).toBe("skills");
  });
});
