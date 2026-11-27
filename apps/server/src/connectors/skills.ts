// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_SKILL_BYTES, type ServedSkill } from "@j3-bots/connectors";
import type { BotId, ConnectorId } from "@j3-bots/contracts";
import type { CatalogSkill } from "@j3-bots/prompts";

/**
 * The skills connectors serve, as bots use them (decision 0089): which one a
 * bot names, and the ones it loaded, whose files it may then read.
 *
 * A skill is its connector's and its address: two connectors may serve a
 * skill of the same name, and so may one connector at two addresses, and
 * none replaces another. A bot names one by name within its connector, or
 * by its address when the name is shared.
 */

/** The skill `named` names among `skills`: by its address, else by a name only one of them has. */
export const findSkill = (
  skills: ReadonlyArray<ServedSkill>,
  named: string,
):
  | { readonly _tag: "found"; readonly skill: ServedSkill }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "none" } => {
  const byAddress = skills.find((skill) => skill.uri === named);
  if (byAddress !== undefined) return { _tag: "found", skill: byAddress };
  const byName = skills.filter((skill) => skill.name === named);
  const [only] = byName;
  if (only === undefined) return { _tag: "none" };
  return byName.length === 1 ? { _tag: "found", skill: only } : { _tag: "ambiguous" };
};

/** Whether `named` is an address rather than a name: a name holds no `/`. */
export const isAddress = (named: string): boolean => named.includes("/");

/**
 * A skill a bot loaded: its connector, and its entry as the bot loaded it,
 * which every read of its files is checked against. Kept in memory only: a
 * bot whose server restarted loads the skill again.
 */
export interface HeldSkill {
  readonly connectorId: ConnectorId;
  readonly skill: ServedSkill;
  /** Bytes of its files read since it was loaded, for one its server generates: at most {@link MAX_SKILL_BYTES}. */
  readonly bytes: number;
}

/** The most skills one bot holds at once; loading another lets go of the one it used longest ago. */
const MAX_HELD_SKILLS = 32;

/** Every bot's held skills, the one it used last at the end. */
export type HeldSkills = ReadonlyMap<BotId, ReadonlyArray<HeldSkill>>;

const same = (a: HeldSkill, connectorId: ConnectorId, uri: string) =>
  a.connectorId === connectorId && a.skill.uri === uri;

/** `held` with `skill` held by `botId`, in place of the entry it held for that skill. */
export const hold = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  skill: ServedSkill,
): HeldSkills => {
  const others = (held.get(botId) ?? []).filter((entry) => !same(entry, connectorId, skill.uri));
  return new Map(held).set(
    botId,
    [...others, { connectorId, skill, bytes: 0 }].slice(-MAX_HELD_SKILLS),
  );
};

/** The skill of `connectorId` `named` names among those `botId` holds. */
export const heldSkill = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  named: string,
):
  | { readonly _tag: "found"; readonly held: HeldSkill }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "none" } => {
  const mine = (held.get(botId) ?? []).filter((entry) => entry.connectorId === connectorId);
  const found = findSkill(
    mine.map((entry) => entry.skill),
    named,
  );
  if (found._tag !== "found") return found;
  const entry = mine.find((one) => one.skill === found.skill);
  return entry === undefined ? { _tag: "none" } : { _tag: "found", held: entry };
};

/** `held` with what `botId` read of a skill counted against it. */
export const counted = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  uri: string,
  bytes: number,
): HeldSkills =>
  new Map(held).set(
    botId,
    (held.get(botId) ?? []).map((entry) =>
      same(entry, connectorId, uri) ? { ...entry, bytes: entry.bytes + bytes } : entry,
    ),
  );

/** `held` without what `botId` held of a skill. */
export const letGo = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  uri: string,
): HeldSkills =>
  new Map(held).set(
    botId,
    (held.get(botId) ?? []).filter((entry) => !same(entry, connectorId, uri)),
  );

/** `held` without anything of `connectorId`'s, once it is removed. */
export const forgetConnector = (held: HeldSkills, connectorId: ConnectorId): HeldSkills =>
  new Map(
    [...held].map(([botId, entries]) => [
      botId,
      entries.filter((entry) => entry.connectorId !== connectorId),
    ]),
  );

/** Whether reading `bytes` more of a held skill its server generates stays within the extension's limit. */
export const withinBudget = (entry: HeldSkill, bytes: number): boolean =>
  entry.skill.files !== null || entry.bytes + bytes <= MAX_SKILL_BYTES;

/**
 * Each connector's skills as `use_connector_skill`'s description lists them:
 * a skill whose name another of its connector's has is named by its address.
 */
export const catalogOf = (
  offered: ReadonlyArray<{
    readonly connector: { readonly name: string; readonly slug: string };
    readonly skills: ReadonlyArray<ServedSkill>;
  }>,
): ReadonlyArray<CatalogSkill> =>
  offered.flatMap(({ connector, skills }) =>
    skills.map((skill) => ({
      connector: connector.name,
      slug: connector.slug,
      name: skill.name,
      uri: skill.uri,
      description: skill.description,
      shared: skills.some((other) => other !== skill && other.name === skill.name),
    })),
  );

/**
 * Whether two entries of a skill give the same instructions: its
 * `SKILL.md` has the same digest in both, or for a skill its server
 * generates, the same frontmatter.
 */
export const sameInstructions = (a: ServedSkill, b: ServedSkill): boolean => {
  if (a.uri !== b.uri) return false;
  const { resources: before } = a.entry;
  const { resources: after } = b.entry;
  if (before === "dynamic" || after === "dynamic") {
    return (
      before === after &&
      JSON.stringify(a.entry.frontmatter) === JSON.stringify(b.entry.frontmatter)
    );
  }
  const digestOf = (files: typeof before) => files.find((file) => file.uri === a.uri)?.digest;
  const digest = digestOf(before);
  return digest !== undefined && digest === digestOf(after);
};

/** A fingerprint of what a connector serves of skills, as bots are offered them. */
export const skillsFingerprint = (skills: ReadonlyArray<ServedSkill>): string =>
  JSON.stringify(skills.map((skill) => [skill.uri, skill.name, skill.description, skill.tooLarge]));
