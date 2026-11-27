// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FaceLight } from "@j3-bots/client-runtime/presentation";
import type { AvatarState } from "@j3-bots/client-runtime/presentation";
import type { BotId } from "@j3-bots/contracts";
import { View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useBots } from "../presentation.tsx";

/** How many faces show before they stop overlapping into one more. */
const SHOWN = 3;

const stateOf = {
  acting: "working",
  waiting: "waiting",
  still: "idle",
} as const satisfies Record<FaceLight, AvatarState>;

/**
 * The faces of the bots on a tab, overlapping, the most recent in front:
 * the antenna's light is on for the one acting, amber for one that waits for
 * the person. A bot that is gone shows no face. The words beside them say
 * who they are; the faces alone are hidden from screen readers.
 */
export function Faces({
  faces,
  size = 22,
}: {
  readonly faces: ReadonlyArray<{ readonly botId: BotId; readonly light: FaceLight }>;
  readonly size?: number;
}) {
  const bots = useBots();
  const shown = faces.flatMap((face) => {
    const bot = bots.get(face.botId);
    return bot === undefined ? [] : [{ bot, light: face.light }];
  });
  if (shown.length === 0) return null;
  return (
    <View
      className="flex-row items-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {shown
        .slice(0, SHOWN)
        .reverse()
        .map(({ bot, light }, index) => (
          <View key={bot.id} style={{ marginStart: index === 0 ? 0 : -size / 3 }}>
            <BotAvatar
              avatar={bot.profile.avatar}
              seed={bot.id}
              state={stateOf[light]}
              size={size}
              still
              cutout
            />
          </View>
        ))}
    </View>
  );
}
