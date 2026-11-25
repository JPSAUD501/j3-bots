// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Mentions } from "@j3-bots/contracts";
import type { IntentFailure } from "../intents/Actions.ts";
import type { MentionLabel } from "../stores/Conversations.ts";
import type { Addressing, DraftMention } from "../stores/Drafts.ts";
import { endsAt, literalRanges, opensAt } from "./messageText.ts";

/** A room member the operator can mention, by the name the room shows. */
export interface Mentionable {
  readonly id: BotId;
  readonly name: string;
}

/** What the picker offers: one member, or every member, each asked to answer. */
export type MentionOption =
  | { readonly _tag: "bot"; readonly id: BotId; readonly name: string }
  | { readonly _tag: "everyone" };

/** The word after `@` that mentions every member. The same in every language, as the server's. */
export const EVERYONE = "everyone";

/** What a picked mention writes in the text. */
const mentionToken = (mention: DraftMention) =>
  `@${mention._tag === "bot" ? mention.label : EVERYONE}`;

const inLiteral = (ranges: ReadonlyArray<readonly [number, number]>, at: number) =>
  ranges.some(([start, end]) => at >= start && at < end);

/**
 * Whether a picked mention still addresses anyone: its token is intact where
 * it was written, opens and ends as a mention does, and is not in code or a
 * link, by the same rules the bubble highlights it by.
 */
const stands = (
  text: string,
  mention: DraftMention,
  literal: ReadonlyArray<readonly [number, number]>,
) => {
  const token = mentionToken(mention);
  return (
    text.startsWith(token, mention.position) &&
    opensAt(text, mention.position) &&
    endsAt(text, mention.position + token.length) &&
    !inLiteral(literal, mention.position)
  );
};

/**
 * Who a room message addresses, as `message.send` takes it: only mentions the
 * operator picked count, and only while they stand in the text as it is sent,
 * trimmed as `Drafts.send` trims it. `@everyone` asks every member; otherwise
 * each member mentioned, by the id picked, in the order they appear. A member
 * no longer in the room is left out. With it, the names the members it
 * mentions were picked by where those picks stand, in the order they appear:
 * the first for each member is the pick that addressed it. `undefined` when
 * it addresses nobody, which every member reads.
 */
export function addressed(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
  members: ReadonlyArray<BotId>,
): Addressing | undefined {
  const sent = text.trim();
  // Where the text sent starts in the draft: mentions are placed in the draft.
  const offset = text.length - text.trimStart().length;
  const literal = literalRanges(sent);
  const standing = mentions
    .map((mention) => ({ ...mention, position: mention.position - offset }))
    .filter((mention) => mention.position >= 0 && stands(sent, mention, literal))
    .toSorted((a, b) => a.position - b.position);
  if (standing.some((mention) => mention._tag === "everyone")) {
    return { mentions: { _tag: "everyone" }, labels: [] };
  }
  const ids: Array<BotId> = [];
  const labels: Array<MentionLabel> = [];
  for (const mention of standing) {
    if (mention._tag !== "bot" || !members.includes(mention.botId)) continue;
    if (!ids.includes(mention.botId)) ids.push(mention.botId);
    const { botId, label } = mention;
    if (!labels.some((kept) => kept.botId === botId && kept.label === label)) {
      labels.push({ botId, label });
    }
  }
  return ids.length === 0 ? undefined : { mentions: { _tag: "bots", ids }, labels };
}

/**
 * The names a room message highlights: those of the members it addressed, as
 * the server took them, or `@everyone`. Each member goes by the names it was
 * picked by, when the message keeps them, else by its name now. A name that
 * merely reads like a mention is not highlighted.
 */
export function mentionedNames(
  mentions: Mentions | null,
  labels: ReadonlyArray<MentionLabel>,
  nameOf: (botId: BotId) => string | undefined,
): ReadonlyArray<string> {
  if (mentions === null) return [];
  if (mentions._tag === "everyone") return [EVERYONE];
  return mentions.ids.flatMap((id) => {
    const picked = labels.flatMap((label) => (label.botId === id ? [label.label] : []));
    return picked.length > 0 ? picked : (nameOf(id) ?? []);
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
 * pick in it is gone whatever was pasted or typed over it, even the same
 * text. Otherwise the edit is the one run of text that changed; the caret
 * after it, when known, places that run where the operator typed, so a
 * character typed just before an `@` moves the mention rather than breaking
 * it. Editing a mention's token, even one character of it, ends that mention.
 */
export function followEdit(
  before: string,
  after: string,
  { replaced: selection, caret }: EditPlace,
  mentions: ReadonlyArray<DraftMention>,
): ReadonlyArray<DraftMention> {
  if (mentions.length === 0) return mentions;
  const run = selection === null ? null : replacedSelection(before, after, selection);
  if (run !== null) {
    const [from, to] = run;
    const moved = replaced(mentions, from, to, after.length - before.length + (to - from));
    return moved.filter((mention) => after.startsWith(mentionToken(mention), mention.position));
  }
  if (before === after) return mentions;
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

/**
 * What text dragged out of the field carries: the text, where it was taken
 * from, and the mentions wholly in it, placed from its start.
 */
export interface DraggedText {
  readonly text: string;
  /** Where the text starts in the field it was dragged from. */
  readonly from: number;
  readonly mentions: ReadonlyArray<DraftMention>;
}

/** What dragging `[start, end)` of `text` carries, with the mentions picked in it. */
export function draggedText(
  text: string,
  [start, end]: readonly [number, number],
  mentions: ReadonlyArray<DraftMention>,
): DraggedText {
  return {
    text: text.slice(start, end),
    from: start,
    mentions: mentions.flatMap((mention) =>
      mention.position >= start && mention.position + mentionToken(mention).length <= end
        ? [{ ...mention, position: mention.position - start }]
        : [],
    ),
  };
}

/**
 * The mentions once text was dropped into the field at `at`, turning
 * `before` into `after`: those already there move with the text after the
 * drop, and, when the text dropped is what `dragged` carried out of this
 * field, its mentions come with it. When `after` is not `before` with text
 * inserted at `at`, as when a browser leaves the caret elsewhere than at the
 * end of the text dropped, the drop is followed as any other edit, as the one
 * run of text that changed.
 */
function followDrop(
  before: string,
  after: string,
  at: number,
  mentions: ReadonlyArray<DraftMention>,
  dragged: DraggedText | null,
): ReadonlyArray<DraftMention> {
  const inserted = after.length - before.length;
  if (
    inserted <= 0 ||
    at < 0 ||
    after.slice(0, at) !== before.slice(0, at) ||
    after.slice(at + inserted) !== before.slice(at)
  ) {
    return followEdit(before, after, { replaced: null, caret: null }, mentions);
  }
  const moved = replaced(mentions, at, at, inserted);
  const carried =
    dragged !== null && after.slice(at, at + inserted) === dragged.text
      ? dragged.mentions.map((mention) => ({ ...mention, position: mention.position + at }))
      : [];
  return [...moved, ...carried].filter((mention) =>
    after.startsWith(mentionToken(mention), mention.position),
  );
}

/**
 * Where `text`, taken out of the field leaving `taken`, was put back to give
 * `after`: `hint` when it fits there, else the first place it fits; null when
 * `after` is not `taken` with `text` put back in.
 */
function movedTo(taken: string, after: string, text: string, hint: number): number | null {
  if (after.length !== taken.length + text.length) return null;
  // Before the place, `after` reads as `taken`; after the text put back, it does again.
  const lowest = Math.max(0, taken.length - commonSuffix(taken, after));
  const highest = Math.min(taken.length, commonPrefix(taken, after));
  if (hint >= lowest && hint <= highest && after.startsWith(text, hint)) return hint;
  for (let at = lowest; at <= highest; at += 1) {
    if (after.startsWith(text, at)) return at;
  }
  return null;
}

/**
 * The mentions once an edit of a drag `dragged` carried out of this field
 * turned `before` into `after`, with the text dropped, if any, ending at
 * `dropEnd`. A move within the field may come as two edits, the text taken
 * out and then dropped in, or as one that already sees the text moved, which
 * moves the mentions in it, even when the field reads the same after it, as
 * when "@Ana " is moved past another "@Ana ".
 */
function followDrag(
  before: string,
  after: string,
  dropEnd: number,
  mentions: ReadonlyArray<DraftMention>,
  dragged: DraggedText,
): ReadonlyArray<DraftMention> {
  const source = [dragged.from, dragged.from + dragged.text.length] as const;
  if (before.slice(...source) === dragged.text) {
    const taken = before.slice(0, source[0]) + before.slice(source[1]);
    const left = followEdit(before, taken, { replaced: source, caret: null }, mentions);
    // Taken out, to be dropped in with the next edit, or dropped somewhere else.
    if (after === taken) return left;
    const at = movedTo(taken, after, dragged.text, dropEnd - dragged.text.length);
    if (at !== null) return followDrop(taken, after, at, left, dragged);
  }
  return followDrop(before, after, dropEnd - (after.length - before.length), mentions, dragged);
}

/**
 * An edit of the composer's field, as any field can tell it, whatever events
 * its platform tells it with.
 */
export type FieldEdit =
  /** Text written or taken away where the operator left the selection, or an undo. */
  | {
      readonly _tag: "change";
      /** The text before the edit: what the composer holds. */
      readonly before: string;
      /** The field's text after it. */
      readonly after: string;
      /**
       * The selection the edit wrote over, as `[start, end)` of `before`: what
       * the operator left selected, when the edit wrote text there. Null for
       * an edit that only took text away, or did not write where the operator
       * left the selection, as an undo.
       */
      readonly over: readonly [number, number] | null;
      /** The text the edit wrote, when the field tells it. */
      readonly written: string | null;
      /** The caret after the edit, when the selection is collapsed. */
      readonly caret: number | null;
    }
  /** Text dropped in from outside the field, ending at `end` of `after`. */
  | {
      readonly _tag: "drop";
      readonly before: string;
      readonly after: string;
      readonly end: number;
    }
  /**
   * An edit of a move of `dragged` within the field: the text taken out,
   * dropped back in, or both at once. The text dropped, if any, ends at
   * `end` of `after`.
   */
  | {
      readonly _tag: "move";
      readonly before: string;
      readonly after: string;
      readonly end: number;
      readonly dragged: DraggedText;
    };

/**
 * The mentions that still stand after `edit`. Text moved within the field
 * moves the mentions in it (`followDrag`); text dropped from elsewhere moves
 * those after it. A change that wrote over the selection replaced it, so a
 * pick in it is gone, also when the text reads the same after it, as for the
 * same text pasted or typed over it, unless what it wrote is not the
 * selection's text: then it wrote somewhere else. Any other change, an undo
 * among them, is followed as `followEdit` finds it. A drop leaves the caret,
 * or the text it selects, ending where the text dropped does, which places
 * it. Where a field leaves it elsewhere, the text before and after that place
 * no longer reads as it did, and `followDrop` falls back to following the one
 * run of text that changed.
 */
export function followFieldEdit(
  edit: FieldEdit,
  mentions: ReadonlyArray<DraftMention>,
): ReadonlyArray<DraftMention> {
  switch (edit._tag) {
    case "move":
      return followDrag(edit.before, edit.after, edit.end, mentions, edit.dragged);
    case "drop": {
      const { before, after, end } = edit;
      return followDrop(before, after, end - (after.length - before.length), mentions, null);
    }
    case "change": {
      const { before, after, over, written, caret } = edit;
      const elsewhere =
        before === after && over !== null && written !== null && written !== before.slice(...over);
      return elsewhere ? mentions : followEdit(before, after, { replaced: over, caret }, mentions);
    }
  }
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
  if (inLiteral(literalRanges(text), start)) return null;
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
