// SPDX-License-Identifier: AGPL-3.0-or-later
import { entrySummary } from "@j3-bots/client-runtime/wording";
import type { BotId, Entry, MessageEntry, NoticeEntry, WorkFoldEntry } from "@j3-bots/contracts";
import { use } from "react";
import { Text, View } from "react-native";
import { usePresentation } from "../presentation.tsx";
import { EntryWidths } from "./MessageBubble.tsx";

/** The entries that are cards: what the bot asks, a teammate message, a routine changed. */
export type CardEntry = Exclude<Entry, MessageEntry | NoticeEntry | WorkFoldEntry>;

/**
 * A card in one line, as the roster says it: "Asks: …" while the bot waits on
 * it, in the waiting color. The phone's cards that take an answer come later;
 * until then this says what each one is.
 */
export function CardFrame({
  entry,
  owner,
  current,
}: {
  readonly entry: CardEntry;
  /** The bot whose conversation it is, null in a room. */
  readonly owner: BotId | null;
  /** The bot waits on this card now. */
  readonly current: boolean;
}) {
  const ctx = usePresentation();
  const widths = use(EntryWidths);
  return (
    <View className="mt-2 px-4">
      <View
        style={{ maxWidth: widths.card }}
        className={`self-start rounded-md border px-3 py-2 ${current ? "border-waiting bg-waiting-surface" : "border-border bg-surface"}`}
      >
        <Text className={`text-base ${current ? "text-waiting" : "text-foreground"}`}>
          {entrySummary(entry, ctx, { owner, current })}
        </Text>
      </View>
    </View>
  );
}
