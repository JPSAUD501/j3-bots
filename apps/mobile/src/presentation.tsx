// SPDX-License-Identifier: AGPL-3.0-or-later
import { knownTimeZone } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import type { PresentationContext } from "@j3-bots/client-runtime/wording";
import type { Bot, BotId } from "@j3-bots/contracts";
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

/**
 * What every sentence and time on screen needs: the language, the time now,
 * the operator's time zone as saved in Settings (the device's until the
 * settings are read, or when the device does not know that zone), and every
 * bot by id.
 */
export function PresentationProvider({ children }: { readonly children: ReactNode }) {
  const i18n = useI18n();
  const now = useNow();
  const settings = useSettings();
  const roster = useReadable(useJ3Client().roster);
  const saved = settings._tag === "ready" ? settings.value.timeZone : null;
  const timeZone = useMemo(
    () => (saved === null ? null : knownTimeZone(saved)) ?? deviceTimeZone(),
    [saved],
  );
  // Every bot, hidden ones too: an old message names its speaker however the roster shows it now.
  const bots = useMemo(
    () =>
      new Map(
        (roster._tag === "ready" ? roster.value : []).flatMap((item) =>
          item._tag === "bot" ? [[item.bot.id, item.bot] as const] : [],
        ),
      ),
    [roster],
  );
  const context = useMemo(
    (): PresentationContext => ({
      i18n,
      now,
      timeZone,
      botName: (id: BotId) => bots.get(id)?.profile.name ?? null,
    }),
    [i18n, now, timeZone, bots],
  );
  return (
    <PresentationContextValue value={context}>
      <BotsContext value={bots}>{children}</BotsContext>
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
