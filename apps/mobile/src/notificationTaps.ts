// SPDX-License-Identifier: AGPL-3.0-or-later
import { pushOpening } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { EntryTarget, RosterItemKey } from "@j3-bots/contracts";
import * as Notifications from "expo-notifications";
import { useEffect, useEffectEvent, useRef } from "react";

const itemOf = (target: EntryTarget): RosterItemKey =>
  target._tag === "conversation"
    ? { _tag: "bot", botId: target.botId }
    : { _tag: "room", roomId: target.roomId };

/**
 * Opens the conversation or room a tapped push is about, with `open`, as the
 * runtime decides (`pushOpening`): only while this app follows the pairing
 * the push was sent to, and the roster lists what it is about. A tap that
 * started the app is read once it is paired; one that came before the roster
 * loaded waits for it.
 */
export function useNotificationTaps(open: (item: RosterItemKey) => void): void {
  const client = useJ3Client();
  const roster = useReadable(client.roster);
  /** A tap waiting for the roster. */
  const waiting = useRef<{ readonly data: unknown } | null>(null);
  /** The notification last tapped, which the system may report twice as the app starts. */
  const tapped = useRef<string | null>(null);

  const decide = useEffectEvent((data: unknown) => {
    const opening = pushOpening(data, client.pairing.get(), client.roster.get());
    waiting.current = opening._tag === "wait" ? { data } : null;
    if (opening._tag === "open") open(itemOf(opening.target));
  });
  const take = useEffectEvent((response: Notifications.NotificationResponse) => {
    const { identifier, content } = response.notification.request;
    if (identifier === tapped.current) return;
    tapped.current = identifier;
    Notifications.clearLastNotificationResponse();
    decide(content.data ?? null);
  });

  useEffect(() => {
    const last = Notifications.getLastNotificationResponse();
    if (last !== null) take(last);
    const subscription = Notifications.addNotificationResponseReceivedListener(take);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const tap = waiting.current;
    if (tap !== null && roster._tag === "ready") decide(tap.data);
  }, [roster]);
}
