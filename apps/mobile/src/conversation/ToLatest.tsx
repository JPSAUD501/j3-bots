// SPDX-License-Identifier: AGPL-3.0-or-later
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { ArrowDown, ArrowUp } from "lucide-react-native";
import type { CardPlace } from "@j3-bots/client-runtime/presentation";
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
 * Over the end of a conversation. While its bot waits on a card out of view,
 * "Waiting for you" with an arrow toward the card, which brings it into view.
 * Otherwise, scrolled up: "New messages" while others wrote some, else a
 * round button back to the newest entry once the operator is well away from
 * it. It pops in and out, and is hidden from screen readers while it does
 * not show.
 */
export function ToLatest({
  end,
  onPress,
  waiting,
}: {
  readonly end: ConversationEnd;
  readonly onPress: () => void;
  /** The card the bot waits on, where it is, and the way to it; null while it waits on nothing. */
  readonly waiting: { readonly place: CardPlace | null; readonly onPress: () => void } | null;
}) {
  const { t } = useI18n();
  const toCard = waiting !== null && (waiting.place === "above" || waiting.place === "below");
  const fresh = !toCard && end.unseen > 0;
  const shown = toCard || (!end.atEnd && (fresh || end.away));
  const worded = toCard || fresh;
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
          depth={worded ? "control" : "round"}
          accessibilityRole="button"
          accessibilityLabel={
            toCard
              ? t("timeline.toWaiting")
              : fresh
                ? t("timeline.newMessages")
                : t("timeline.toLatest")
          }
          onPress={toCard ? waiting.onPress : onPress}
          className={`h-11 flex-row items-center justify-center gap-1.5 rounded-pill border border-border bg-surface ${worded ? "ps-4 pe-3.5" : "w-11"}`}
        >
          {worded && (
            <Text className={`text-sm font-medium ${toCard ? "text-waiting" : "text-foreground"}`}>
              {toCard ? t("presence.waiting") : t("timeline.newMessages")}
            </Text>
          )}
          <Icon
            icon={toCard && waiting.place === "above" ? ArrowUp : ArrowDown}
            size={16}
            color={toCard ? "accent-waiting" : "accent-foreground"}
          />
        </PressScale>
      </AnimatedView>
    </View>
  );
}
