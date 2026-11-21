// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention, IntentFailure } from "@j3-bots/client-runtime";
import type { BotId, Mentions } from "@j3-bots/contracts";
import type { I18n } from "../i18n/i18n";
import { codeRanges } from "./messageText";

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

/** What a picked mention writes in the text. */
const mentionToken = (mention: DraftMention) =>
  `@${mention._tag === "bot" ? mention.label : EVERYONE}`;

/**
 * A mention opens at the start of the text, after a space or after opening
 * punctuation, so an address like `ana@example.com` holds none.
 */
const opensAt = (text: string, at: number) =>
  at === 0 || /[\s([{"'“‘«:]/u.test(text.charAt(at - 1));

/** A name ends where the text does or where no letter, digit or underscore follows. */
const endsAt = (text: string, at: number) => !/[\p{L}\p{N}\p{M}_]/u.test(text.charAt(at));

const inCode = (ranges: ReadonlyArray<readonly [number, number]>, at: number) =>
  ranges.some(([start, end]) => at >= start && at < end);

/**
 * Whether a picked mention still addresses anyone: its token is intact where
 * it was written, opens and ends as a mention does, and is not in code.
 */
const stands = (
  text: string,
  mention: DraftMention,
  code: ReadonlyArray<readonly [number, number]>,
) => {
  const token = mentionToken(mention);
  return (
    text.startsWith(token, mention.position) &&
    opensAt(text, mention.position) &&
    endsAt(text, mention.position + token.length) &&
    !inCode(code, mention.position)
  );
};

/**
 * Who a room message addresses, as `message.send` takes it: only mentions the
 * operator picked count, and only while they stand. `@everyone` asks every
 * member; otherwise each member mentioned, by the id picked, in the order they
 * appear. A member no longer in the room is left out. `undefined` when it
 * addresses nobody, which goes to the host.
 */
export function addressed(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
  members: ReadonlyArray<BotId>,
): Mentions | undefined {
  const code = codeRanges(text);
  const standing = mentions
    .filter((mention) => stands(text, mention, code))
    .toSorted((a, b) => a.position - b.position);
  if (standing.some((mention) => mention._tag === "everyone")) return { _tag: "everyone" };
  const ids: Array<BotId> = [];
  for (const mention of standing) {
    if (mention._tag === "bot" && members.includes(mention.botId) && !ids.includes(mention.botId)) {
      ids.push(mention.botId);
    }
  }
  return ids.length === 0 ? undefined : { _tag: "bots", ids };
}

/**
 * Who a room message wakes, as the server routes it, in a line: each member
 * mentioned, in turn; every member; or, mentioning nobody, the host. Null
 * while a name to show is not known.
 */
export function addresseeLine(
  mentions: Mentions | undefined,
  hostId: BotId | null,
  nameOf: (botId: BotId) => string | undefined,
  { t, locale }: I18n,
): string | null {
  if (mentions === undefined || (mentions._tag === "bots" && mentions.ids.length === 0)) {
    const host = hostId === null ? undefined : nameOf(hostId);
    return host === undefined ? null : t("composer.to.host", { name: host });
  }
  if (mentions._tag === "everyone") return t("composer.to.everyone");
  const names = mentions.ids.flatMap((id) => nameOf(id) ?? []);
  if (names.length === 0) return null;
  return t("composer.to", {
    names: new Intl.ListFormat(locale, { type: "conjunction" }).format(names),
  });
}

/**
 * The mentions after `[from, to)` of the text was replaced by `inserted`
 * characters: those before stay, those after move with the text, and one the
 * change touched is gone.
 */
function replaced(
  mentions: ReadonlyArray<DraftMention>,
  from: number,
  to: number,
  inserted: number,
): ReadonlyArray<DraftMention> {
  return mentions.flatMap((mention) => {
    const end = mention.position + mentionToken(mention).length;
    if (end <= from) return [mention];
    if (mention.position >= to) {
      return [{ ...mention, position: mention.position + inserted - (to - from) }];
    }
    return [];
  });
}

const commonPrefix = (a: string, b: string) => {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
};

const commonSuffix = (a: string, b: string) => {
  let length = 0;
  while (
    length < a.length &&
    length < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
};

/**
 * The mentions of `before` that still stand once the operator edited it into
 * `after`. The edit is the one run of text that changed; the caret after it,
 * when known, places that run where the operator typed, so a character typed
 * just before an `@` moves the mention rather than breaking it. Editing a
 * mention's token, even one character of it, ends that mention.
 */
export function followEdit(
  before: string,
  after: string,
  caret: number | null,
  mentions: ReadonlyArray<DraftMention>,
): ReadonlyArray<DraftMention> {
  if (mentions.length === 0 || before === after) return mentions;
  // The text after the caret is untouched, so the changed run ends at the caret at the latest.
  const suffix = Math.min(
    commonSuffix(before, after),
    caret === null ? Number.POSITIVE_INFINITY : after.length - caret,
  );
  const prefix = Math.min(
    commonPrefix(before, after),
    Math.min(before.length, after.length) - suffix,
  );
  const moved = replaced(mentions, prefix, before.length - suffix, after.length - suffix - prefix);
  return moved.filter((mention) => after.startsWith(mentionToken(mention), mention.position));
}

/** The mention being typed: where its `@` is, and what follows it up to the caret. */
export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

/** Text compared as a reader would: whatever its case and accents, composed or not. */
const folded = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLocaleLowerCase();

/** Whether `name` starts with `query`, or one of its words does, folded. */
const nameMatches = (name: string, query: string) => {
  const typed = folded(query);
  const words = folded(name);
  if (words.startsWith(typed)) return true;
  for (const space of words.matchAll(/\s+/gu)) {
    if (words.startsWith(typed, space.index + space[0].length)) return true;
  }
  return false;
};

/**
 * What the picker offers for `query`: the members whose name, or a word of
 * it, starts with it, in the room's order, then `@everyone` when it matches.
 * Two members of the same name are both offered: the one picked is the one
 * mentioned.
 */
export function mentionOptions(
  query: string,
  members: ReadonlyArray<Mentionable>,
): ReadonlyArray<MentionOption> {
  const bots = members
    .filter((member) => nameMatches(member.name, query))
    .map((member): MentionOption => ({ _tag: "bot", id: member.id, name: member.name }));
  return folded(EVERYONE).startsWith(folded(query)) ? [...bots, { _tag: "everyone" }] : bots;
}

/**
 * The mention the caret is in, if any: an `@` that opens a mention, outside
 * code and not one a pick already wrote, followed by the caret on the same
 * line. What follows the `@` may hold spaces, for a name of several words;
 * the picker closes once no option matches it.
 */
export function mentionQuery(
  text: string,
  caret: number,
  mentions: ReadonlyArray<DraftMention>,
): MentionQuery | null {
  if (caret === 0) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const start = text.lastIndexOf("@", caret - 1);
  if (start < lineStart || !opensAt(text, start)) return null;
  if (mentions.some((mention) => mention.position === start)) return null;
  if (inCode(codeRanges(text), start)) return null;
  return { start, query: text.slice(start + 1, caret) };
}

/**
 * How far the name `option` writes already runs on from `start`'s `@`, folded,
 * so picking an option the operator finished typing replaces what they typed
 * rather than writing it twice.
 */
function typedEnd(text: string, start: number, caret: number, name: string): number {
  const lineEnd = text.indexOf("\n", start);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  const wanted = folded(name);
  for (let end = limit; end > caret; end -= 1) {
    if (folded(text.slice(start + 1, end)) === wanted && endsAt(text, end)) return end;
  }
  return caret;
}

/**
 * `text` with the mention being typed replaced by `option`'s token, the
 * mentions it then holds, the new one among them, and where the caret goes:
 * past the token and the space after it. A space is added unless the text
 * goes on with one, or with punctuation. A name typed in full already is
 * replaced, not written again.
 */
export function insertMention(
  text: string,
  caret: number,
  mentions: ReadonlyArray<DraftMention>,
  { start }: MentionQuery,
  option: MentionOption,
): {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  readonly caret: number;
} {
  const mention: DraftMention =
    option._tag === "bot"
      ? { _tag: "bot", botId: option.id, label: option.name, position: start }
      : { _tag: "everyone", position: start };
  const token = mentionToken(mention);
  const end = typedEnd(text, start, caret, option._tag === "bot" ? option.name : EVERYONE);
  const after = text.slice(end);
  const spaced = after !== "" && endsAt(after, 0) ? token : `${token} `;
  return {
    text: `${text.slice(0, start)}${spaced}${after}`,
    mentions: [...replaced(mentions, start, end, spaced.length), mention],
    caret: start + token.length + (spaced !== token || /^\s/u.test(after) ? 1 : 0),
  };
}

/** The option `step` places from `active` among `count`, wrapping at both ends. */
export const movedOption = (active: number, step: number, count: number) =>
  count === 0 ? 0 : (((active + step) % count) + count) % count;

/**
 * For a room message the server refused for its mentions: the members it
 * mentions who are no longer in the room, and its mentions without them,
 * which `message.send` takes. Null when none of them has left, as for a
 * refusal of another kind.
 */
export function mentionedWhoLeft(
  failure: IntentFailure,
  mentions: Mentions | null,
  members: ReadonlyArray<BotId>,
): { readonly left: ReadonlyArray<BotId>; readonly without: Mentions } | null {
  if (
    failure._tag !== "refused" ||
    failure.error._tag !== "Invalid" ||
    failure.error.reason !== "mentions" ||
    mentions?._tag !== "bots"
  ) {
    return null;
  }
  const left = mentions.ids.filter((id) => !members.includes(id));
  if (left.length === 0) return null;
  return {
    left,
    without: { _tag: "bots", ids: mentions.ids.filter((id) => members.includes(id)) },
  };
}
