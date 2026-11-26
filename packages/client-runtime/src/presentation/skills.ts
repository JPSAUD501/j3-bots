// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Bot, type Skill, SkillName, type SkillScope, SkillText } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The skills of one scope, as the list shows them. */
export interface SkillGroup {
  readonly scope: SkillScope;
  readonly skills: ReadonlyArray<Skill>;
}

/** Whether two scopes are the same. */
export const sameScope = (a: SkillScope, b: SkillScope): boolean =>
  a._tag === "all-bots" ? b._tag === "all-bots" : b._tag === "bot" && b.botId === a.botId;

const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);

/**
 * The skills the operator or a bot added, by scope: every bot's first, then
 * each bot's own, in the order `bots` lists them, each by name. A scope with
 * none is left out. J3 Bots' own skills are not listed: every bot has them,
 * and nobody changes them.
 */
export const skillGroups = (
  skills: ReadonlyArray<Skill>,
  bots: ReadonlyArray<Bot>,
): ReadonlyArray<SkillGroup> => {
  const added = skills.filter((skill) => !skill.shipped);
  const of = (scope: SkillScope): SkillGroup => ({
    scope,
    skills: added.filter((skill) => sameScope(skill.scope, scope)).toSorted(byName),
  });
  return [
    of({ _tag: "all-bots" }),
    ...bots.map((bot) => of({ _tag: "bot", botId: bot.id })),
  ].filter((group) => group.skills.length > 0);
};

/** A name and `SKILL.md` the server takes, or none. */
export const skillDraft = (
  name: string,
  text: string,
): { readonly name: SkillName; readonly text: SkillText } | null => {
  const checkedName = Schema.decodeOption(SkillName)(name.trim());
  const checkedText = Schema.decodeOption(SkillText)(text);
  return Option.isSome(checkedName) && Option.isSome(checkedText)
    ? { name: checkedName.value, text: checkedText.value }
    : null;
};
