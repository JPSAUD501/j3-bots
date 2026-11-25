// SPDX-License-Identifier: AGPL-3.0-or-later
import { answeringLine } from "@j3-bots/client-runtime/wording";
import type { Room } from "@j3-bots/contracts";
import { springs } from "@j3-bots/design-tokens";
import { View } from "react-native";
import { AvatarStack } from "../components/avatar/BotAvatar.tsx";
import { SwapText } from "../components/SwapText.tsx";
import { settleIn } from "../motion.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { AnimatedView } from "./animated.ts";

/**
 * At the end of a room, who is answering there now: their faces, overlapping,
 * and one quiet line, "Hal and Bo are answering…", that changes in place as
 * each one's turn ends. It settles in as someone starts and goes once nobody
 * answers. TalkBack reads it out as it changes, politely.
 */
export function AnsweringLine({ room }: { readonly room: Room }) {
  const bots = useBots();
  const { i18n } = usePresentation();
  const line = answeringLine(room, (botId) => bots.get(botId)?.profile.name, i18n);
  return (
    <View accessibilityLiveRegion="polite">
      {line !== null && (
        <AnimatedView
          entering={settleIn(springs.soft)}
          className="min-h-8 flex-row items-center gap-2.5 px-3"
        >
          <AvatarStack
            size={20}
            members={line.faces.flatMap((id) => {
              const bot = bots.get(id);
              return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
            })}
          />
          <View className="min-w-0 flex-1">
            <SwapText text={line.text} className="text-xs text-muted-foreground" />
          </View>
        </AnimatedView>
      )}
    </View>
  );
}
