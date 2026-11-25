// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, BotId } from "@j3-bots/contracts";
import { useContext } from "react";
import { View } from "react-native";
import { AvatarsAsleep, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Text } from "../text.tsx";
import { inlineChip } from "./inlineChip.ts";
import { useTint } from "./tint.ts";

/** The side of a mention's face, in px: as small as an event line's, so it sits in a line of text. */
export const MENTION_FACE = 16;

/**
 * A bot's mention where it stands in a message's text: its still face and
 * `@` and the name, on a tint of its color. It carries its own fill and text
 * color, which keep the name readable inside any bubble.
 */
export function MentionChip({
  avatar,
  seed,
  name,
}: {
  readonly avatar: Avatar;
  readonly seed: BotId;
  readonly name: string;
}) {
  const { bubble } = useTint(avatar);
  const asleep = useContext(AvatarsAsleep);
  return (
    <View
      style={[inlineChip, { backgroundColor: bubble }]}
      className="mx-px flex-row items-center gap-1 rounded-full ps-1 pe-2"
    >
      <BotAvatar
        avatar={avatar}
        seed={seed}
        state={asleep ? "offline" : "idle"}
        size={MENTION_FACE}
        still
      />
      <Text numberOfLines={1} className="shrink text-base font-semibold text-bubble-bot-foreground">
        @{name}
      </Text>
    </View>
  );
}
