// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, BotId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { createI18n, resolveLocale, type I18n, type Locale } from "../i18n/i18n";
import { usePreferences } from "../preferences/preferences";
import type { PresentationContext } from "../presentation/roster";

const I18nContext = createContext<I18n>(createI18n("en"));

/** Interface text in the operator's language: their choice, or the browser's. */
export function I18nProvider({ locale, children }: { locale?: Locale; children: ReactNode }) {
  const { language } = usePreferences();
  const resolved =
    locale ?? (language === "system" ? resolveLocale(navigator.languages) : language);
  const i18n = useMemo(() => createI18n(resolved), [resolved]);
  useEffect(() => {
    document.documentElement.lang = resolved;
  }, [resolved]);
  return <I18nContext value={i18n}>{children}</I18nContext>;
}

export const useI18n = () => use(I18nContext);

interface Clock {
  readonly now: DateTime.Utc;
  readonly timeZone: string;
}

const ClockContext = createContext<Clock>({
  now: DateTime.makeUnsafe(0),
  timeZone: "UTC",
});

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The current time for relative labels, updated every half minute. `now` pins it. */
export function ClockProvider({ now, children }: { now?: DateTime.Utc; children: ReactNode }) {
  const [ticking, setTicking] = useState(() => DateTime.makeUnsafe(Date.now()));
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setTicking(DateTime.makeUnsafe(Date.now())), 30_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const clock = useMemo(
    () => ({ now: now ?? ticking, timeZone: systemTimeZone() }),
    [now, ticking],
  );
  return <ClockContext value={clock}>{children}</ClockContext>;
}

const BotsContext = createContext<ReadonlyMap<BotId, Bot>>(new Map());

/** Every bot the operator has, so any entry can show who said or was asked something. */
export function BotsProvider({
  bots,
  children,
}: {
  bots: ReadonlyArray<Bot>;
  children: ReactNode;
}) {
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  return <BotsContext value={byId}>{children}</BotsContext>;
}

export const useBot = (id: BotId): Bot | null => use(BotsContext).get(id) ?? null;
export const useBots = (): ReadonlyMap<BotId, Bot> => use(BotsContext);

export function usePresentation(): PresentationContext {
  const i18n = use(I18nContext);
  const { now, timeZone } = use(ClockContext);
  const bots = use(BotsContext);
  return useMemo(
    () => ({ i18n, now, timeZone, botName: (id: BotId) => bots.get(id)?.profile.name ?? null }),
    [i18n, now, timeZone, bots],
  );
}
