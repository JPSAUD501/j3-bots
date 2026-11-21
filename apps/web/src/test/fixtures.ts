// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small builders for tests, with only what a test cares about given. */
import {
  BotId,
  ModelId,
  ProviderId,
  type Bot,
  type BotState,
  type Language,
} from "@j3-bots/contracts";
import type { PresentationContext } from "@j3-bots/client-runtime/wording";
import { createI18n } from "@j3-bots/i18n";
import * as DateTime from "effect/DateTime";

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
