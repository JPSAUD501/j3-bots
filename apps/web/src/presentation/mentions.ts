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
 * operator picked count, and only while they stand in the text as it is sent,
 * trimmed as `Drafts.send` trims it. `@everyone` asks every member; otherwise
 * each member mentioned, by the id picked, in the order they appear. A member
 * no longer in the room is left out. `undefined` when it addresses nobody,
 * which goes to the host.
 */
export function addressed(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
  members: ReadonlyArray<BotId>,
): Mentions | undefined {
  const sent = text.trim();
  // Where the text sent starts in the draft: mentions are placed in the draft.
  const offset = text.length - text.trimStart().length;
  const code = codeRanges(sent);
  const standing = mentions
    .map((mention) => ({ ...mention, position: mention.position - offset }))
    .filter((mention) => mention.position >= 0 && stands(sent, mention, code))
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

/** Who a room message wakes, as the server routes it, by the names to show. */
export type Addressee =
  | { readonly _tag: "host"; readonly name: string }
  | { readonly _tag: "everyone" }
  | { readonly _tag: "bots"; readonly names: string }
  | null;

/**
 * Who a room message wakes: each member mentioned, in turn; every member; or,
 * mentioning nobody, the room's host, named as it is now. Null while a name
 * to show is not known.
 */
export function addresseeOf(
  mentions: Mentions | null,
  hostId: BotId | null,
  nameOf: (botId: BotId) => string | undefined,
  { locale }: I18n,
): Addressee {
  if (mentions === null || (mentions._tag === "bots" && mentions.ids.length === 0)) {
    const host = hostId === null ? undefined : nameOf(hostId);
    return host === undefined ? null : { _tag: "host", name: host };
  }
  if (mentions._tag === "everyone") return { _tag: "everyone" };
  const names = mentions.ids.flatMap((id) => nameOf(id) ?? []);
  if (names.length === 0) return null;
  return {
    _tag: "bots",
    names: new Intl.ListFormat(locale, { type: "conjunction" }).format(names),
  };
}

/**
 * Who a room message wakes, in the quiet line under the composer. A message
 * for nobody goes to whoever hosts when it arrives, so the line says the
 * host, and who that is now.
 */
export function addresseeLine(to: Addressee, { t }: I18n): string | null {
  if (to === null) return null;
  switch (to._tag) {
    case "host":
      return t("composer.to.host", { name: to.name });
    case "everyone":
      return t("composer.to.everyone");
    case "bots":
      return t("composer.to", { names: to.names });
  }
}

/**
 * What Send again says for a room message that goes again to `to`, without
 * the members who left: to the host when none of those it mentioned is left.
 */
export function resendLabel(to: Addressee, { t }: I18n): string {
  if (to === null || to._tag === "everyone") return t("message.retry");
  return to._tag === "host"
    ? t("message.retry.host", { name: to.name })
    : t("message.retry.to", { names: to.names });
}

/**
 * The names a room message highlights: those it addressed, as the server
 * took them, or `@everyone`. A name that merely reads like a mention is not
 * highlighted.
 */
export function mentionedNames(
  mentions: Mentions | null,
  nameOf: (botId: BotId) => string | undefined,
): ReadonlyArray<string> {
  if (mentions === null) return [];
  if (mentions._tag === "everyone") return [EVERYONE];
  return mentions.ids.flatMap((id) => nameOf(id) ?? []);
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

/** Where the field's selection was before an edit, and where its caret is after it. */
export interface EditPlace {
  /** The selection the edit replaced, as `[start, end)` of the text before it, when it held text. */
  readonly replaced: readonly [number, number] | null;
  /** The caret after the edit, when the selection is collapsed. */
  readonly caret: number | null;
}

/**
 * The run `[from, to)` of `before` that an edit replacing the selection
 * `[start, end)` changed into `after`, or null when `after` is not such an
 * edit, as for an undo.
 */
function replacedSelection(
  before: string,
  after: string,
  [start, end]: readonly [number, number],
): readonly [number, number] | null {
  const kept = before.length - end;
  return start < end &&
    end <= before.length &&
    after.length - kept >= start &&
    after.startsWith(before.slice(0, start)) &&
    after.endsWith(before.slice(end))
    ? [start, end]
    : null;
}

/**
 * The mentions of `before` that still stand once the operator edited it into
 * `after`. An edit over a selection replaced exactly that selection, so a
 * pick in it is gone whatever was pasted or typed over it. Otherwise the edit
 * is the one run of text that changed; the caret after it, when known, places
 * that run where the operator typed, so a character typed just before an `@`
 * moves the mention rather than breaking it. Editing a mention's token, even
 * one character of it, ends that mention.
 */
export function followEdit(
  before: string,
  after: string,
  { replaced: selection, caret }: EditPlace,
  mentions: ReadonlyArray<DraftMention>,
): ReadonlyArray<DraftMention> {
  if (mentions.length === 0 || before === after) return mentions;
  const run = selection === null ? null : replacedSelection(before, after, selection);
  if (run !== null) {
    const [from, to] = run;
    const moved = replaced(mentions, from, to, after.length - before.length + (to - from));
    return moved.filter((mention) => after.startsWith(mentionToken(mention), mention.position));
  }
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
 * rather than writing it twice. Typed in full, the name is at most as long as
 * it is decomposed, so only that much of the line is looked at.
 */
function typedEnd(text: string, start: number, caret: number, name: string): number {
  const lineEnd = text.indexOf("\n", start);
  const longest = start + 1 + name.normalize("NFD").length;
  const limit = Math.min(lineEnd === -1 ? text.length : lineEnd, longest);
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
 * goes on with one, or with punctuation or a new line, which the caret stays
 * before. A name typed in full already is replaced, not written again.
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
    caret: start + token.length + (spaced !== token || after.startsWith(" ") ? 1 : 0),
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
