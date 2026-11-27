// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { BotId, RosterItemKey, RoutineId } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { Linking } from "react-native";
import { type AppLink, appLinkOf, appScheme } from "./links.ts";

/** Whether the link the app was started with has been taken: it is the same for as long as the app runs. */
let startTaken = false;

/**
 * Opens what one of the app's own links names, as a widget or a Direct
 * Share shortcut opens the app: a bot's conversation with `open`, a
 * routine's runs with `openRuns`. Only for a bot the roster lists; a link
 * that came before the roster loaded waits for it.
 */
export function useAppLinks(
  open: (item: RosterItemKey) => void,
  openRuns: (botId: BotId, routineId: RoutineId) => void,
): void {
  const client = useJ3Client();
  const roster = useReadable(client.roster);
  /** A link waiting for the roster. */
  const waiting = useRef<AppLink | null>(null);

  const decide = useEffectEvent((link: AppLink) => {
    const items = client.roster.get();
    if (items._tag !== "ready") {
      waiting.current = link;
      return;
    }
    waiting.current = null;
    if (!items.value.some((item) => item._tag === "bot" && item.bot.id === link.botId)) return;
    if (link._tag === "bot") open({ _tag: "bot", botId: link.botId });
    else openRuns(link.botId, link.routineId);
  });
  const take = useEffectEvent((url: string | null | undefined) => {
    const scheme = appScheme();
    const link = typeof url !== "string" || scheme === null ? null : appLinkOf(scheme, url);
    if (link !== null) decide(link);
  });

  useEffect(() => {
    if (!startTaken) {
      startTaken = true;
      void Linking.getInitialURL().then(take);
    }
    const subscription = Linking.addEventListener("url", ({ url }) => take(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const link = waiting.current;
    if (link !== null && roster._tag === "ready") decide(link);
  }, [roster]);
}
