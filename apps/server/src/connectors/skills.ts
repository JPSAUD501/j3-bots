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

/** Whether `named` is a skill's address, its `SKILL.md`'s, which its server may be asked for. */
export const isAddress = (named: string): boolean =>
  named.endsWith("/SKILL.md") && URL.canParse(named);

/**
 * A skill a bot loaded: its connector, and its entry as the bot loaded it,
 * which every read of its files is checked against. Kept in memory only: a
 * bot whose server restarted loads the skill again.
 */
export interface HeldSkill {
  readonly connectorId: ConnectorId;
  readonly skill: ServedSkill;
  /** `Seen.signing` when it was loaded: what signed the connector's requests then. */
  readonly signing: number;
  /** Bytes of its files read since it was loaded, its `SKILL.md` too: for one its server generates, at most {@link MAX_SKILL_BYTES}. */
  readonly bytes: number;
}

/** The most skills one bot holds at once; loading another lets go of the one it used longest ago. */
const MAX_HELD_SKILLS = 32;

/** Every bot's held skills, the one it used last at the end. */
export type HeldSkills = ReadonlyMap<BotId, ReadonlyArray<HeldSkill>>;

const same = (a: HeldSkill, connectorId: ConnectorId, uri: string) =>
  a.connectorId === connectorId && a.skill.uri === uri;

/** `held` with a skill `botId` loaded, in place of the entry it held for that skill. */
export const hold = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  loaded: Omit<HeldSkill, "connectorId">,
): HeldSkills => {
  const others = (held.get(botId) ?? []).filter(
    (entry) => !same(entry, connectorId, loaded.skill.uri),
  );
  return new Map(held).set(botId, [...others, { connectorId, ...loaded }].slice(-MAX_HELD_SKILLS));
};

/** `held` with the entry `botId` holds of `skill` replaced by the one its server gives now. */
export const renewed = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  skill: ServedSkill,
): HeldSkills =>
  new Map(held).set(
    botId,
    (held.get(botId) ?? []).map((entry) =>
      same(entry, connectorId, skill.uri) ? { ...entry, skill } : entry,
    ),
  );

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

/**
 * Whether `botId` may have read `bytes` more of a skill it holds, and `held`
 * with them counted when it may: a skill its server generates is read up to
 * the extension's limit for each load, {@link MAX_SKILL_BYTES}. One checked
 * against its manifest is within it already.
 */
export const charged = (
  held: HeldSkills,
  botId: BotId,
  connectorId: ConnectorId,
  uri: string,
  bytes: number,
): readonly [boolean, HeldSkills] => {
  const entries = held.get(botId) ?? [];
  const entry = entries.find((one) => same(one, connectorId, uri));
  // Let go of meanwhile: nothing left to count against.
  if (entry === undefined) return [true, held];
  if (entry.skill.files === null && entry.bytes + bytes > MAX_SKILL_BYTES) return [false, held];
  return [
    true,
    new Map(held).set(
      botId,
      entries.map((one) => (one === entry ? { ...one, bytes: one.bytes + bytes } : one)),
    ),
  ];
};

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

/**
 * Each connector's skills as `use_connector_skill`'s description lists them,
 * from all it listed: one too large to load is left out, and one whose name
 * another of its connector's has, too large or not, is named by its address,
 * as {@link findSkill} finds it.
 */
export const catalogOf = (
  listed: ReadonlyArray<{
    readonly connector: { readonly name: string; readonly slug: string };
    readonly skills: ReadonlyArray<ServedSkill>;
  }>,
): ReadonlyArray<CatalogSkill> =>
  listed.flatMap(({ connector, skills }) =>
    skills
      .filter((skill) => !skill.tooLarge)
      .map((skill) => ({
        connector: connector.name,
        slug: connector.slug,
        name: skill.name,
        uri: skill.uri,
        description: skill.description,
        shared: skills.some((other) => other !== skill && other.name === skill.name),
      })),
  );

/** `value` as JSON with every object's keys in order, so two equal values read the same whatever order they came in. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
};

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
    return before === after && canonical(a.entry.frontmatter) === canonical(b.entry.frontmatter);
  }
  const digestOf = (files: typeof before) => files.find((file) => file.uri === a.uri)?.digest;
  const digest = digestOf(before);
  return digest !== undefined && digest === digestOf(after);
};

/** A fingerprint of what a connector serves of skills, as bots are offered them. */
export const skillsFingerprint = (skills: ReadonlyArray<ServedSkill>): string =>
  JSON.stringify(skills.map((skill) => [skill.uri, skill.name, skill.description, skill.tooLarge]));
