// SPDX-License-Identifier: AGPL-3.0-or-later
import { aiNameOf, knownTimeZone } from "@j3-bots/client-runtime/presentation";
import {
  useEngineStatus,
  useJ3Client,
  useReadable,
  useSettings,
} from "@j3-bots/client-runtime/react";
import type { PresentationContext } from "@j3-bots/client-runtime/wording";
import type { J3Client } from "@j3-bots/client-runtime";
import type { Bot, BotId, EngineStatus, Room, RoomId, RosterItem } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import * as DateTime from "effect/DateTime";
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";
import { useI18n } from "./i18n.ts";
import { phoneTimeZone } from "./platform/timeZone.ts";

const deviceTimeZone = () => phoneTimeZone() ?? "UTC";

/** The current time for relative labels, updated every half minute. */
function useNow(): DateTime.Utc {
  const [now, setNow] = useState(() => DateTime.makeUnsafe(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setNow(DateTime.makeUnsafe(Date.now())), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const PresentationContextValue = createContext<PresentationContext | null>(null);
const BotsContext = createContext<ReadonlyMap<BotId, Bot>>(new Map());
const RoomsContext = createContext<ReadonlyMap<RoomId, Room>>(new Map());

/** The time zone the operator saved, when the device knows it; else the device's own. */
const timeZoneOf = (saved: string | null): string =>
  (saved === null ? null : knownTimeZone(saved)) ?? deviceTimeZone();

/** Every bot by id, hidden ones too: an old message names its speaker however the roster shows it now. */
const botsOf = (roster: ReadonlyArray<RosterItem>): ReadonlyMap<BotId, Bot> =>
  new Map(
    roster.flatMap((item) => (item._tag === "bot" ? [[item.bot.id, item.bot] as const] : [])),
  );

/**
 * Every room by id, archived and hidden ones too, so a notice or a mention
 * names the room as it is called now.
 */
const roomsOf = (roster: ReadonlyArray<RosterItem>): ReadonlyMap<RoomId, Room> =>
  new Map(
    roster.flatMap((item) => (item._tag === "room" ? [[item.room.id, item.room] as const] : [])),
  );

const contextOf = (input: {
  readonly i18n: I18n;
  readonly now: DateTime.Utc;
  readonly timeZone: string;
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly rooms: ReadonlyMap<RoomId, Room>;
  readonly engine: EngineStatus | null;
}): PresentationContext => ({
  i18n: input.i18n,
  now: input.now,
  timeZone: input.timeZone,
  botName: (id: BotId) => input.bots.get(id)?.profile.name ?? null,
  roomName: (id: RoomId) => input.rooms.get(id)?.name ?? null,
  aiName: (bot: Bot) => aiNameOf(input.engine, bot.model.providerId),
});

/**
 * What every sentence needs, read from `client` as it is now, for what is
 * worded outside the screens: what a home-screen widget says.
 */
export const presentationNow = (client: J3Client, i18n: I18n): PresentationContext => {
  const roster = client.roster.get();
  const items = roster._tag === "ready" ? roster.value : [];
  const settings = client.settings.get();
  const engine = client.engine.get();
  return contextOf({
    i18n,
    now: DateTime.makeUnsafe(Date.now()),
    timeZone: timeZoneOf(settings._tag === "ready" ? settings.value.timeZone : null),
    bots: botsOf(items),
    rooms: roomsOf(items),
    engine: engine._tag === "ready" ? engine.value : null,
  });
};

/**
 * What every sentence and time on screen needs: the language, the time now,
 * the operator's time zone as saved in Settings (the device's until the
 * settings are read, or when the device does not know that zone), and every
 * bot and room by id.
 */
export function PresentationProvider({ children }: { readonly children: ReactNode }) {
  const i18n = useI18n();
  const now = useNow();
  const settings = useSettings();
  const roster = useReadable(useJ3Client().roster);
  const engineStatus = useEngineStatus();
  const engine = engineStatus._tag === "ready" ? engineStatus.value : null;
  const saved = settings._tag === "ready" ? settings.value.timeZone : null;
  const timeZone = useMemo(() => timeZoneOf(saved), [saved]);
  const bots = useMemo(() => botsOf(roster._tag === "ready" ? roster.value : []), [roster]);
  const rooms = useMemo(() => roomsOf(roster._tag === "ready" ? roster.value : []), [roster]);
  const context = useMemo(
    () => contextOf({ i18n, now, timeZone, bots, rooms, engine }),
    [i18n, now, timeZone, bots, rooms, engine],
  );
  return (
    <PresentationContextValue value={context}>
      <BotsContext value={bots}>
        <RoomsContext value={rooms}>{children}</RoomsContext>
      </BotsContext>
    </PresentationContextValue>
  );
}

export const usePresentation = (): PresentationContext => {
  const context = use(PresentationContextValue);
  if (context === null) throw new Error("usePresentation needs a PresentationProvider above it.");
  return context;
};

/** Every bot the operator has, by id, hidden ones included. */
export const useBots = (): ReadonlyMap<BotId, Bot> => use(BotsContext);

/** Every room the operator has, by id, archived and hidden ones included. */
export const useRooms = (): ReadonlyMap<RoomId, Room> => use(RoomsContext);

/** Every bot the operator has, hidden ones included, in the roster's order. */
export const useBotList = (): ReadonlyArray<Bot> => {
  const bots = useBots();
  return useMemo(() => [...bots.values()], [bots]);
};
