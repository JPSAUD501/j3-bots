// SPDX-License-Identifier: AGPL-3.0-or-later
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { ArrowDown } from "lucide-react-native";
import type { ConversationEnd } from "@j3-bots/client-runtime/react";
import { useEffect } from "react";
import { View } from "react-native";
import { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { AnimatedView } from "./animated.ts";

/**
 * Over the end of a conversation scrolled up: "New messages" while others
 * wrote some, else a round button back to the newest entry once the operator
 * is well away from it. It pops in and out, and is hidden from screen
 * readers while it does not show.
 */
export function ToLatest({
  end,
  onPress,
}: {
  readonly end: ConversationEnd;
  readonly onPress: () => void;
}) {
  const { t } = useI18n();
  const fresh = end.unseen > 0;
  const shown = !end.atEnd && (fresh || end.away);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(withSpring(shown ? 1 : 0, reanimatedSpring(springs.pop)));
  }, [shown, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, progress.get())),
    transform: [{ scale: 0.5 + 0.5 * progress.get() }],
  }));
  return (
    <View pointerEvents="box-none" className="items-center">
      <AnimatedView
        style={style}
        pointerEvents={shown ? "auto" : "none"}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      >
        <PressScale
          depth={fresh ? "control" : "round"}
          accessibilityRole="button"
          accessibilityLabel={fresh ? t("timeline.newMessages") : t("timeline.toLatest")}
          onPress={onPress}
          className={`h-11 flex-row items-center justify-center gap-1.5 rounded-pill border border-border bg-surface ${fresh ? "ps-4 pe-3.5" : "w-11"}`}
        >
          {fresh && (
            <Text className="text-sm font-medium text-foreground">{t("timeline.newMessages")}</Text>
          )}
          <Icon icon={ArrowDown} size={16} color="accent-foreground" />
        </PressScale>
      </AnimatedView>
    </View>
  );
}
