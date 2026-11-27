// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GroupPosition } from "@j3-bots/client-runtime/presentation";
import type { BotId } from "@j3-bots/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useBotCardPress } from "../components/BotCard.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";

/** A speaker's face, beside the last bubble of its group. */
const FACE = 28;

/** How far a speaker's name and bubbles stand from the edge: its face and the gap after it. */
export const speakerGutter = FACE + 8;

/**
 * A bot's message where several bots speak, in a room or a teammate
 * conversation: the bot's name over the first bubble of its group, its still
 * face at the bottom left of the last, and the message beside it. A bot
 * deleted since keeps its place, as "A deleted bot" by a plain disc. The face
 * carries who spoke, never what the bot is doing now. A long press on the
 * name or the face opens the bot's card (decision 0102).
 */
export function Speaker({
  botId,
  position,
  children,
}: {
  readonly botId: BotId;
  readonly position: GroupPosition;
  /** The message: its bubble, and whatever stands with it. */
  readonly children: ReactNode;
}) {
  const { t } = usePresentation().i18n;
  const bot = useBots().get(botId);
  const card = useBotCardPress(bot === undefined ? null : botId, bot?.profile.name ?? "");
  const startsGroup = position === "single" || position === "first";
  const endsGroup = position === "single" || position === "last";
  return (
    <>
      {startsGroup && (
        <Text
          numberOfLines={1}
          className="self-start pb-1 text-xs font-medium text-foreground"
          style={{ paddingStart: speakerGutter }}
          {...card?.props}
        >
          {bot?.profile.name ?? t("bot.unknown")}
        </Text>
      )}
      <View className="flex-row items-end gap-2">
        <View style={{ width: FACE }}>
          {endsGroup &&
            (bot === undefined ? (
              <View className="rounded-pill bg-muted" style={{ width: FACE, height: FACE }} />
            ) : (
              // A screen reader reaches the card from the name, which it reads first.
              <Pressable accessible={false} onLongPress={card?.props.onLongPress}>
                <BotAvatar
                  avatar={bot.profile.avatar}
                  seed={bot.id}
                  state="idle"
                  size={FACE}
                  still
                />
              </Pressable>
            ))}
        </View>
        {/* As wide as the row, so a visual stretches across it; bubbles keep to the face. */}
        <View className="min-w-0 flex-1 items-start gap-1">{children}</View>
      </View>
    </>
  );
}
