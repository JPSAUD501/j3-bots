// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Mentions } from "@j3-bots/contracts";

/** A room member the operator can mention, by the name the room shows. */
export interface Mentionable {
  readonly id: BotId;
  readonly name: string;
}

/** What the picker offers: one member, or every member in turn. */
export type MentionOption =
  | { readonly _tag: "bot"; readonly id: BotId; readonly name: string }
  | { readonly _tag: "everyone" };

/** The word after `@` that mentions every member. The same in every language, as the server's. */
export const EVERYONE = "everyone";

/** A mention starts the text or follows a space, so an address like `ana@example.com` is none. */
const opensMention = (text: string, at: number) => at === 0 || /\s/u.test(text.charAt(at - 1));

/** A name ends where the text does or where no letter, digit or underscore follows. */
const endsName = (text: string, at: number) => !/[\p{L}\p{N}_]/u.test(text.charAt(at));

/** The option named right after the `@` at `at`. */
function mentionAt(
  text: string,
  at: number,
  byLength: ReadonlyArray<Mentionable>,
): MentionOption | null {
  const options: ReadonlyArray<MentionOption> = [
    ...byLength.map((member) => ({ _tag: "bot" as const, id: member.id, name: member.name })),
    { _tag: "everyone" },
  ];
  for (const option of options) {
    const name = option._tag === "bot" ? option.name : EVERYONE;
    const end = at + 1 + name.length;
    const written = text.slice(at + 1, end);
    if (written.toLocaleLowerCase() === name.toLocaleLowerCase() && endsName(text, end)) {
      return option;
    }
  }
  return null;
}

/**
 * Who a room message addresses, as `message.send` takes it: `@everyone`
 * anywhere asks every member; otherwise each member named with `@`, in the
 * order first named. A name matches whatever its case, and a longer name wins
 * over one it starts with. `undefined` when it names nobody, which goes to
 * the host.
 */
export function mentionsIn(
  text: string,
  members: ReadonlyArray<Mentionable>,
): Mentions | undefined {
  const byLength = members.toSorted((a, b) => b.name.length - a.name.length);
  const ids: Array<BotId> = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!opensMention(text, at)) continue;
    const found = mentionAt(text, at, byLength);
    if (found === null) continue;
    if (found._tag === "everyone") return { _tag: "everyone" };
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return ids.length === 0 ? undefined : { _tag: "bots", ids };
}

/** The mention being typed: where its `@` is, and what follows it up to the caret. */
export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

/**
 * The mention the caret is in, if any: an `@` that opens a mention, followed
 * by no space up to the caret.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1 || !opensMention(text, start)) return null;
  const query = before.slice(start + 1);
  return /\s/u.test(query) ? null : { start, query };
}

/**
 * What the picker offers for `query`: the members a word of whose name starts
 * with it, in the room's order, then `@everyone` when it matches.
 */
export function mentionOptions(
  query: string,
  members: ReadonlyArray<Mentionable>,
): ReadonlyArray<MentionOption> {
  const typed = query.toLocaleLowerCase();
  const bots = members
    .filter((member) =>
      member.name
        .toLocaleLowerCase()
        .split(/\s+/u)
        .some((word) => word.startsWith(typed)),
    )
    .map((member): MentionOption => ({ _tag: "bot", id: member.id, name: member.name }));
  return EVERYONE.startsWith(typed) ? [...bots, { _tag: "everyone" }] : bots;
}

/** `text` with the mention being typed replaced by `option`, and where the caret goes after it. */
export function insertMention(
  text: string,
  caret: number,
  { start }: MentionQuery,
  option: MentionOption,
): { readonly text: string; readonly caret: number } {
  const mention = `@${option._tag === "bot" ? option.name : EVERYONE}`;
  const after = text.slice(caret);
  // One space after the name, unless one is already there.
  const spaced = after.startsWith(" ") ? mention : `${mention} `;
  return {
    text: `${text.slice(0, start)}${spaced}${after}`,
    caret: start + spaced.length + (after.startsWith(" ") ? 1 : 0),
  };
}

/** The option `step` places from `active` among `count`, wrapping at both ends. */
export const movedOption = (active: number, step: number, count: number) =>
  count === 0 ? 0 : (((active + step) % count) + count) % count;
