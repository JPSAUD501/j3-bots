// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  Invalid,
  type Skill,
  type SkillScope,
  type SkillText,
  skillFrontmatter,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { SkillsIntents } from "../components/connectors/Skills";
import { ids, SAMPLE_NOW } from "./sample";

const ago = (minutes: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - minutes * 60_000);

const text = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThe steps, as the bot wrote them.\n`;

const sameScope = (a: SkillScope, b: SkillScope) =>
  a._tag === "all-bots" ? b._tag === "all-bots" : b._tag === "bot" && b.botId === a.botId;

/** The sample team's skills: J3 Bots' own, one the operator wrote, one installed, and a bot's. */
export const sampleSkills: ReadonlyArray<Skill> = [
  {
    name: "j3-routines",
    scope: { _tag: "all-bots" },
    description: "Set up, change or check a routine.",
    files: 0,
    shipped: true,
    source: null,
    lastChange: null,
  },
  {
    name: "release-notes",
    scope: { _tag: "all-bots" },
    description: "When writing release notes: the sections, the tone and what to leave out.",
    files: 1,
    shipped: false,
    source: {
      _tag: "git",
      repository: "https://git.example.com/team/skills.git",
      path: "skills/release-notes",
      commit: "3f2a9c1e7b5d4a6f8e0c2b1a9d8e7f6a5b4c3d2e",
    },
    lastChange: { by: { _tag: "bot", botId: ids.scout }, at: ago(60 * 26) },
  },
  {
    name: "weekly-review",
    scope: { _tag: "all-bots" },
    description: "Every Friday's review: what shipped, what slipped, and what is next.",
    files: 0,
    shipped: false,
    source: { _tag: "written" },
    lastChange: { by: { _tag: "operator" }, at: ago(60 * 24 * 4) },
  },
  {
    name: "trip-planning",
    scope: { _tag: "bot", botId: ids.otto },
    description: "When planning a trip: dates first, then travel, then where to stay.",
    files: 0,
    shipped: false,
    source: { _tag: "written" },
    lastChange: { by: { _tag: "bot", botId: ids.otto }, at: ago(90) },
  },
];

/** The skills a source of the sample holds, and a way to change them. */
export interface SkillsHolder {
  readonly get: () => ReadonlyArray<Skill>;
  readonly set: (skills: ReadonlyArray<Skill>) => void;
}

/** How long the sample's server takes to answer. */
const ANSWER_DELAY = 450;

const later = <A>(value: A): Promise<A> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ANSWER_DELAY));
const done = <A>(value: A) => later({ _tag: "done", value } as const);
const refused = (error: Conflict | Invalid) =>
  later({ _tag: "failed", failure: { _tag: "refused", error } } as const);

/** What the skills pages ask of the sample's server, which keeps what the operator writes. */
export function sampleSkillsIntents(holder: SkillsHolder): SkillsIntents {
  const texts = new Map<string, SkillText>();
  const key = (scope: SkillScope, name: string) =>
    `${scope._tag === "all-bots" ? "all-bots" : scope.botId}/${name}`;
  const put = (skill: Skill) => {
    holder.set([
      ...holder
        .get()
        .filter((each) => !(each.name === skill.name && sameScope(each.scope, skill.scope))),
      skill,
    ]);
    return done(skill);
  };
  return {
    read: (scope, name) => {
      const skill = holder.get().find((each) => each.name === name && sameScope(each.scope, scope));
      return done(texts.get(key(scope, name)) ?? text(name, skill?.description ?? ""));
    },
    save: (scope, name, written) => {
      const front = skillFrontmatter(written);
      if (typeof front === "string" || front.name !== name)
        return refused(new Invalid({ reason: "skill-text" }));
      texts.set(key(scope, name), written);
      return put({
        name,
        scope,
        description: front.description,
        files: 0,
        shipped: false,
        source: { _tag: "written" },
        lastChange: { by: { _tag: "operator" }, at: SAMPLE_NOW },
      });
    },
    install: ({ scope, name, repository, path }) =>
      repository.includes("example")
        ? put({
            name,
            scope,
            description: "Installed from the sample's repository.",
            files: 2,
            shipped: false,
            source: {
              _tag: "git",
              repository,
              path,
              commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            },
            lastChange: { by: { _tag: "operator" }, at: SAMPLE_NOW },
          })
        : refused(new Conflict({ reason: "skill-fetch" })),
    remove: (scope, name) => {
      holder.set(
        holder.get().filter((each) => !(each.name === name && sameScope(each.scope, scope))),
      );
      return done(undefined);
    },
  };
}
