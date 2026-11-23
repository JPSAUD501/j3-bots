// SPDX-License-Identifier: AGPL-3.0-or-later
import { handoffPeer } from "@j3-bots/client-runtime/presentation";
import type { BotId, HandoffEntry } from "@j3-bots/contracts";
import { use, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { AvatarShape } from "../components/Avatar.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { EntryWidths } from "./widths.ts";

/**
 * A message between two bots, in either one's conversation: the one this bot
 * sent, or one it received. The line with the other bot's name goes to its
 * conversation; the text opens in full where it is.
 */
export function HandoffCard({
  entry,
  onOpenBot,
}: {
  readonly entry: HandoffEntry;
  readonly onOpenBot: (botId: BotId) => void;
}) {
  const { t } = useI18n();
  const widths = use(EntryWidths);
  const [expanded, setExpanded] = useState(false);
  const peer = handoffPeer(entry);
  const other = useBots().get(peer);
  const name = other?.profile.name ?? t("bot.unknown");
  const line = t(entry.direction === "sent" ? "handoff.to" : "handoff.from", { name });
  const marks = (
    <>
      {entry.urgent && (
        <Text className="rounded-pill bg-waiting-surface px-2.5 py-0.5 text-2xs font-medium text-waiting">
          {t("handoff.urgent")}
        </Text>
      )}
      {entry.state === "not-delivered" && (
        <Text className="text-2xs font-medium text-blocked">{t("handoff.notDelivered")}</Text>
      )}
      {entry.state === "stopped" && (
        <Text className="text-2xs font-medium text-muted-foreground">{t("handoff.stopped")}</Text>
      )}
      {entry.state === "unconfirmed" && (
        <Text className="text-2xs font-medium text-muted-foreground">
          {t("handoff.unconfirmed")}
        </Text>
      )}
    </>
  );
  return (
    <View className="mt-3 px-4">
      <View
        style={{ maxWidth: widths.compactCard }}
        className="flex-row items-start gap-2.5 self-start rounded-bubble border border-border bg-surface px-3.5 py-1.5"
      >
        <View className="mt-2 size-7 items-center justify-center rounded-md bg-muted">
          {other !== undefined && (
            <AvatarShape avatar={other.profile.avatar} size={18} ground="muted" />
          )}
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row flex-wrap items-center gap-1.5">
            {/* A deleted teammate has no conversation to go to. */}
            {other === undefined ? (
              <Text className="min-h-11 py-3 text-xs text-foreground">{line}</Text>
            ) : (
              <Pressable
                accessibilityRole="link"
                onPress={() => onOpenBot(peer)}
                className="min-h-11 justify-center"
              >
                <Text className="text-xs font-medium text-foreground underline">{line}</Text>
              </Pressable>
            )}
            {marks}
          </View>
          {/* The text starts where the name's box ends, as close to it as two 44 px boxes allow. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((open) => !open)}
            className="min-h-11 pb-2"
          >
            <Text
              numberOfLines={expanded ? undefined : 2}
              className="text-sm text-muted-foreground"
            >
              {entry.text}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
