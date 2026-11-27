// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotId,
  EngineStatus,
  Language,
  Room,
  RoomId,
  RosterItem,
} from "@j3-bots/contracts";
import { aiNameOf } from "@j3-bots/client-runtime/presentation";
import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import { createI18n, resolveLocale, type I18n } from "@j3-bots/i18n";
import { usePreferences } from "../preferences/preferences";
import type { PresentationContext } from "@j3-bots/client-runtime/wording";
import { useClock } from "./clock";

const I18nContext = createContext<I18n>(createI18n("en"));

/** Interface text in the operator's language: their choice, or the browser's. */
export function I18nProvider({ locale, children }: { locale?: Language; children: ReactNode }) {
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

const BotsContext = createContext<ReadonlyMap<BotId, Bot>>(new Map());
const RoomsContext = createContext<ReadonlyMap<RoomId, Room>>(new Map());
const EngineContext = createContext<EngineStatus | null>(null);

/**
 * Every bot and room the operator has, so any entry can show who said or was
 * asked something, and a notice can name a room as it is called now; and the
 * engine's status, so a line can name the AI a bot thinks with.
 */
export function RosterProvider({
  roster,
  engine,
  children,
}: {
  roster: ReadonlyArray<RosterItem>;
  engine: EngineStatus | null;
  children: ReactNode;
}) {
  const bots = useMemo(
    () =>
      new Map(
        roster.flatMap((item) => (item._tag === "bot" ? [[item.bot.id, item.bot] as const] : [])),
      ),
    [roster],
  );
  const rooms = useMemo(
    () =>
      new Map(
        roster.flatMap((item) =>
          item._tag === "room" ? [[item.room.id, item.room] as const] : [],
        ),
      ),
    [roster],
  );
  return (
    <BotsContext value={bots}>
      <RoomsContext value={rooms}>
        <EngineContext value={engine}>{children}</EngineContext>
      </RoomsContext>
    </BotsContext>
  );
}

export const useBot = (id: BotId): Bot | null => use(BotsContext).get(id) ?? null;
export const useBots = (): ReadonlyMap<BotId, Bot> => use(BotsContext);
export const useRooms = (): ReadonlyMap<RoomId, Room> => use(RoomsContext);

export function usePresentation(): PresentationContext {
  const i18n = use(I18nContext);
  const { now, timeZone } = useClock();
  const bots = use(BotsContext);
  const rooms = use(RoomsContext);
  const engine = use(EngineContext);
  return useMemo(
    () => ({
      i18n,
      now,
      timeZone,
      botName: (id: BotId) => bots.get(id)?.profile.name ?? null,
      roomName: (id: RoomId) => rooms.get(id)?.name ?? null,
      aiName: (bot: Bot) => aiNameOf(engine, bot.model.providerId),
    }),
    [i18n, now, timeZone, bots, rooms, engine],
  );
}
