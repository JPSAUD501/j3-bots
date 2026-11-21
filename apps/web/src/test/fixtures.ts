// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small builders for tests: one entry or bot, with only what a test cares about given. */
import {
  BotId,
  EntryId,
  ModelId,
  ProviderId,
  type Bot,
  type BotState,
  type EntryPreview,
  type Language,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { createI18n } from "@j3-bots/i18n";
import type { PresentationContext } from "../presentation/roster";

export const at = (iso: string) => DateTime.makeUnsafe(iso);

export function context(
  now: string,
  locale: Language = "en",
  names: Record<string, string> = {},
): PresentationContext {
  return {
    i18n: createI18n(locale),
    timeZone: "America/Sao_Paulo",
    now: at(now),
    botName: (id) => names[id] ?? null,
  };
}

let next = 0;

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

/** Intl separates times with narrow no-break spaces; tests compare plain spaces. */
export const plain = (s: string) => s.replace(/\s/g, " ");
