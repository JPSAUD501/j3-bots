// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small builders for tests: one entry or bot, with only what a test cares about given. */
import {
  BotId,
  EntryId,
  EntryOrder,
  ModelId,
  ProviderId,
  type Bot,
  type BotState,
  type EntryPreview,
  type MessageEntry,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";

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
    kind,
    author,
    text,
    recipientId,
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
    profile: { name, title: "", avatar: { shape: "circle", color: "blue" }, job: "" },
    model: { providerId: ProviderId.make("p"), modelId: ModelId.make("m") },
    permissionMode: "supervised",
    primary: false,
    pinned: false,
    hidden: false,
    state,
    settingsHeld: false,
    createdAt: at("2026-01-01T00:00:00Z"),
    ...extra,
  };
}
