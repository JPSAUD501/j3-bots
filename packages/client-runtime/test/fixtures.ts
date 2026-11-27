// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small builders for tests: one entry or bot, with only what a test cares about given. */
import {
  BotId,
  EntryId,
  EntryOrder,
  ModelId,
  PairSeq,
  pairBotIds,
  ProviderId,
  type Bot,
  type BotState,
  type EntryPreview,
  type HandoffEntry,
  type HandoffState,
  type Language,
  type MessageEntry,
  type TeammateMessage,
  type TeammatePair,
} from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import * as DateTime from "effect/DateTime";
import type { PresentationContext } from "../src/wording/status.ts";

export const at = (iso: string) => DateTime.makeUnsafe(iso);

let next = 0;

export function message(
  createdAt: string,
  author: MessageEntry["author"] = { _tag: "operator" },
  text = "Hello",
  extra: Partial<MessageEntry> = {},
): MessageEntry {
  return {
    _tag: "message",
    id: EntryId.make(`m${++next}`),
    order: EntryOrder.make(next),
    author,
    createdAt: at(createdAt),
    text,
    attachments: [],
    mentions: { _tag: "bots", ids: [] },
    delivery: { _tag: "delivered" },
    commandId: null,
    ...extra,
  };
}

/**
 * A teammate card in `owner`'s conversation: one it sent `peer`, or one
 * `peer` sent it.
 */
export function handoff(
  createdAt: string,
  owner: string,
  peer: string,
  direction: HandoffEntry["direction"],
  state: HandoffState = "sent",
): HandoffEntry {
  const [from, to] = direction === "sent" ? [owner, peer] : [peer, owner];
  return {
    _tag: "handoff",
    id: EntryId.make(`h${++next}`),
    order: EntryOrder.make(next),
    author: { _tag: "bot", botId: BotId.make(from) },
    recipientId: BotId.make(to),
    direction,
    createdAt: at(createdAt),
    text: "Can you check the build?",
    urgent: false,
    state,
  };
}

/** A message `from` sent `to`, as their teammate conversation lists it. */
export function teammateMessage(
  seq: number,
  createdAt: string,
  from: string,
  to: string,
  text = "Can you check the build?",
): TeammateMessage {
  return {
    seq: PairSeq.make(seq),
    from: BotId.make(from),
    to: BotId.make(to),
    sentEntryId: EntryId.make(`sent-${seq}`),
    receivedEntryId: EntryId.make(`received-${seq}`),
    text,
    urgent: false,
    state: "sent",
    createdAt: at(createdAt),
  };
}

/** The pair whose latest message is `last`, holding `count` messages. */
export function teammatePair(last: TeammateMessage, count = 1): TeammatePair {
  return { botIds: pairBotIds(last.from, last.to), lastMessage: last, count };
}

/** A roster row's view of an entry. */
export function preview(
  createdAt: string,
  kind: EntryPreview["kind"] = "message",
  text = "Hello",
  author: EntryPreview["author"] = { _tag: "operator" },
  recipientId: EntryPreview["recipientId"] = null,
): EntryPreview {
  return {
    entryId: EntryId.make(`p${++next}`),
    order: null,
    kind,
    author,
    text,
    recipientId,
    step: null,
    ending: null,
    notice: null,
    createdAt: at(createdAt),
  };
}

export function bot(
  name: string,
  state: BotState = { _tag: "idle" },
  extra: Partial<Bot> = {},
): Bot {
  return {
    id: BotId.make(name.toLowerCase()),
    profile: { name, title: "", avatar: { shape: "dome", color: "cobalt" }, job: "" },
    model: { providerId: ProviderId.make("p"), modelId: ModelId.make("m") },
    effort: null,
    fast: false,
    permissionMode: "supervised",
    primary: false,
    browser: false,
    pinned: false,
    hidden: false,
    sectionId: null,
    state,
    settingsHeld: false,
    forceStop: false,
    opening: false,
    suggestedReply: null,
    createdAt: at("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

/** What wording a moment needs, in São Paulo, with the bots' and the rooms' names by id. */
export function context(
  now: string,
  locale: Language = "en",
  names: Record<string, string> = {},
  roomNames: Record<string, string> = {},
): PresentationContext {
  return {
    i18n: createI18n(locale),
    timeZone: "America/Sao_Paulo",
    now: at(now),
    botName: (id) => names[id] ?? null,
    aiName: () => "Claude",
    roomName: (id) => roomNames[id] ?? null,
  };
}

/** Intl separates times with narrow no-break spaces; tests compare plain spaces. */
export const plain = (s: string) => s.replace(/\s/g, " ");
