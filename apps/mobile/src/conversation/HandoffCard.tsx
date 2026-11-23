// SPDX-License-Identifier: AGPL-3.0-or-later
import { handoffPeer } from "@j3-bots/client-runtime/presentation";
import type { BotId, HandoffEntry } from "@j3-bots/contracts";
import { use, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { MessageText } from "./MessageText.tsx";
import { useTint } from "./tint.ts";
import { EntryWidths } from "./widths.ts";

/**
 * A message between two bots, in either one's conversation: the card of the
 * one this bot sent, or the line and bubble of one it received. The other
 * bot's name goes to its conversation.
 */
export function HandoffCard({
  entry,
  onOpenBot,
}: {
  readonly entry: HandoffEntry;
  readonly onOpenBot: (botId: BotId) => void;
}) {
  return entry.direction === "sent" ? (
    <SentHandoff entry={entry} onOpenBot={onOpenBot} />
  ) : (
    <ReceivedHandoff entry={entry} onOpenBot={onOpenBot} />
  );
}

/** Where the message stands, when it is anything but sent. */
function HandoffMarks({ entry }: { readonly entry: HandoffEntry }) {
  const { t } = useI18n();
  return (
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
}

/** In the sender's conversation: a compact card whose text opens in full where it is. */
function SentHandoff({
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
  const line = t("handoff.to", { name: other?.profile.name ?? t("bot.unknown") });
  return (
    <View className="mt-3 px-4">
      <View
        style={{ maxWidth: widths.compactCard }}
        className="flex-row items-start gap-2.5 self-start rounded-bubble border border-border bg-surface px-3.5 py-1.5"
      >
        <View className="mt-2.5">
          {other !== undefined && (
            <BotAvatar avatar={other.profile.avatar} seed={other.id} state="idle" size={24} still />
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
            <HandoffMarks entry={entry} />
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

/** Where the sender's avatar and name go in the line that introduces it. */
const SENDER = { sender: true } as const;

/**
 * In the recipient's conversation: a centred line naming the sender, which
 * goes to its conversation, over the message in a bubble of the sender's tint.
 */
function ReceivedHandoff({
  entry,
  onOpenBot,
}: {
  readonly entry: HandoffEntry;
  readonly onOpenBot: (botId: BotId) => void;
}) {
  const { t, parts } = useI18n();
  const widths = use(EntryWidths);
  const peer = handoffPeer(entry);
  const other = useBots().get(peer);
  const name = other?.profile.name ?? t("bot.unknown");
  const bubble = useTint(other?.profile.avatar ?? null).bubble;
  const line = (
    <View className="flex-row items-center gap-1.5">
      {parts("handoff.messageFrom", { name: SENDER }).map((part) =>
        typeof part === "string" ? (
          <Text key={part} className="text-2xs text-muted-foreground">
            {part.trim()}
          </Text>
        ) : (
          <View key="sender" className="flex-row items-center gap-1.5">
            {other !== undefined && (
              <BotAvatar
                avatar={other.profile.avatar}
                seed={other.id}
                state="idle"
                size={16}
                still
              />
            )}
            <Text className="text-2xs text-muted-foreground">{name}</Text>
          </View>
        ),
      )}
    </View>
  );
  return (
    <View className="mt-3 gap-1 px-4">
      <View className="flex-row flex-wrap items-center justify-center gap-x-1.5">
        {/* A deleted teammate has no conversation to go to. */}
        {other === undefined ? (
          <View className="min-h-11 justify-center">{line}</View>
        ) : (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t("handoff.messageFrom", { name })}
            onPress={() => onOpenBot(peer)}
            className="min-h-11 justify-center rounded-md px-2 active:bg-muted"
          >
            {line}
          </Pressable>
        )}
        <HandoffMarks entry={entry} />
      </View>
      <View
        style={{ maxWidth: widths.bubble, backgroundColor: bubble }}
        className="self-start rounded-bubble rounded-bl-sm px-3.5 py-2"
      >
        <MessageText text={entry.text} mentionable={[]} className="text-bubble-bot-foreground" />
      </View>
    </View>
  );
}
