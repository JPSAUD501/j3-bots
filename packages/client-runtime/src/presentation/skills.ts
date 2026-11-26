// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  GitRef,
  GitRepository,
  RepositoryPath,
  type Skill,
  SkillName,
  type SkillScope,
  SkillText,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SkillInstall } from "../stores/Skills.ts";

/** The skills of one scope, as the list shows them. */
export interface SkillGroup {
  readonly scope: SkillScope;
  readonly skills: ReadonlyArray<Skill>;
}

const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);

/**
 * The skills by scope: every bot's first, always, then each bot's own, in the
 * order `bots` lists them, for the bots that have any. Within a scope, the
 * operator's and the bots' skills by name, then J3 Bots' own.
 */
export const skillGroups = (
  skills: ReadonlyArray<Skill>,
  bots: ReadonlyArray<Bot>,
): ReadonlyArray<SkillGroup> => {
  const of = (scope: SkillScope): SkillGroup => {
    const held = skills.filter((skill) =>
      scope._tag === "all-bots"
        ? skill.scope._tag === "all-bots"
        : skill.scope._tag === "bot" && skill.scope.botId === scope.botId,
    );
    return {
      scope,
      skills: [
        ...held.filter((skill) => !skill.shipped).toSorted(byName),
        ...held.filter((skill) => skill.shipped).toSorted(byName),
      ],
    };
  };
  return [
    of({ _tag: "all-bots" }),
    ...bots
      .map((bot) => of({ _tag: "bot", botId: bot.id }))
      .filter((group) => group.skills.length > 0),
  ];
};

/** The `SKILL.md` a new skill starts from: its name, and a description to fill in. */
export const newSkillText = (name: string): string => `---\nname: ${name}\ndescription: \n---\n\n`;

/** The name a skill installed from `path` of `repository` takes: its folder's, or the repository's. */
export const installedName = (repository: string, path: string): string => {
  const folder = path.split("/").findLast((segment) => segment !== "");
  if (folder !== undefined) return folder.toLowerCase();
  if (!URL.canParse(repository)) return "";
  const last = new URL(repository).pathname.split("/").findLast((segment) => segment !== "");
  return (last ?? "").replace(/\.git$/, "").toLowerCase();
};

/** What the operator typed to install a skill, before it is checked. */
export interface InstallDraft {
  readonly scope: SkillScope;
  readonly repository: string;
  readonly path: string;
  readonly ref: string;
  /** Empty: `installedName`'s. */
  readonly name: string;
}

/** Which of an install's fields does not hold. */
export type InstallProblem = "repository" | "path" | "ref" | "name";

const decodes =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (value: string) =>
    Schema.decodeOption(schema)(value);

const repositoryOf = decodes(GitRepository);
const pathOf = decodes(RepositoryPath);
const refOf = decodes(GitRef);
const nameOf = decodes(SkillName);

/** The install the server takes, or the fields that do not hold. */
export const skillInstall = (
  draft: InstallDraft,
):
  | { readonly _tag: "valid"; readonly install: SkillInstall }
  | { readonly _tag: "invalid"; readonly problems: ReadonlyArray<InstallProblem> } => {
  const repository = repositoryOf(draft.repository.trim());
  const path = pathOf(draft.path.trim().replace(/^\/+|\/+$/g, ""));
  const ref = refOf(draft.ref.trim());
  const typed = draft.name.trim();
  const name = nameOf(
    typed === "" ? installedName(draft.repository.trim(), draft.path.trim()) : typed,
  );
  if (
    Option.isSome(repository) &&
    Option.isSome(path) &&
    Option.isSome(ref) &&
    Option.isSome(name)
  ) {
    return {
      _tag: "valid",
      install: {
        scope: draft.scope,
        repository: repository.value,
        path: path.value,
        ref: ref.value,
        name: name.value,
      },
    };
  }
  return {
    _tag: "invalid",
    problems: [
      ...(Option.isNone(repository) ? (["repository"] as const) : []),
      ...(Option.isNone(path) ? (["path"] as const) : []),
      ...(Option.isNone(ref) ? (["ref"] as const) : []),
      ...(Option.isNone(name) ? (["name"] as const) : []),
    ],
  };
};

/** A name and `SKILL.md` the server takes, or none. */
export const skillDraft = (
  name: string,
  text: string,
): { readonly name: SkillName; readonly text: SkillText } | null => {
  const checkedName = nameOf(name.trim());
  const checkedText = decodes(SkillText)(text);
  return Option.isSome(checkedName) && Option.isSome(checkedText)
    ? { name: checkedName.value, text: checkedText.value }
    : null;
};

/** Whether two scopes are the same. */
export const sameScope = (a: SkillScope, b: SkillScope): boolean =>
  a._tag === "all-bots" ? b._tag === "all-bots" : b._tag === "bot" && b.botId === a.botId;
