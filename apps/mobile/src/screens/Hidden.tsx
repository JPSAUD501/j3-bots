// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotItem } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { EyeOff } from "lucide-react-native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import { StateMark } from "../components/States.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useOpenConversation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Body, Button } from "../ui.tsx";
import { useBotPlacing } from "./placing.ts";

const slide = reanimatedSpring(springs.slide);
const closing = LinearTransition.springify()
  .mass(slide.mass)
  .stiffness(slide.stiffness)
  .damping(slide.damping);

/**
 * The bots the operator hid, by name, each with Unhide; one with something
 * unread carries a dot. A row opens the bot's conversation, which stays as it
 * was while the bot is hidden. A bot unhidden fades away as the rest close
 * up, and returns to the roster where it belongs; with none left the screen
 * says that hiding keeps a bot working.
 */
export function HiddenScreen({ navigation }: NativeStackScreenProps<Screens, "hidden">) {
  const { t } = useI18n();
  const roster = useReadable(useJ3Client().roster);
  const insets = useSafeAreaInsets();
  const title = t("roster.hidden");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  if (roster._tag === "loading") return <Connecting />;
  const hidden = roster.value
    .filter((item): item is BotItem => item._tag === "bot" && item.bot.hidden)
    .toSorted((a, b) => a.bot.profile.name.localeCompare(b.bot.profile.name));
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ flexGrow: 1, paddingTop: 8, paddingBottom: insets.bottom + 24 }}
    >
      {/* What was there as the screen opened appears in place; only what changes moves. */}
      <LayoutAnimationConfig skipEntering>
        {hidden.length === 0 ? (
          <Animated.View
            entering={FadeIn.duration(motion.state)}
            className="flex-1 items-center justify-center gap-3 px-8"
          >
            <StateMark icon={EyeOff} />
            <Body>{t("roster.hidden.empty")}</Body>
          </Animated.View>
        ) : (
          hidden.map((item) => (
            <Animated.View
              key={item.bot.id}
              exiting={FadeOut.duration(motion.state)}
              layout={closing}
            >
              <HiddenBot item={item} />
            </Animated.View>
          ))
        )}
      </LayoutAnimationConfig>
    </ScrollView>
  );
}

/** A hidden bot: its avatar and name, a dot while something of it is unread, and Unhide. */
function HiddenBot({ item }: { readonly item: BotItem }) {
  const { t } = useI18n();
  const placing = useBotPlacing();
  const openConversation = useOpenConversation();
  const { bot } = item;
  const name = bot.profile.name;
  const [pressed, setPressed] = useState(false);
  return (
    <View className="mx-2 flex-row items-center gap-2 pe-2">
      <PressScale
        depth="row"
        frame={{ flex: 1, minWidth: 0 }}
        accessibilityRole="button"
        accessibilityLabel={[
          name,
          bot.primary ? t("roster.primary") : null,
          item.unread ? t("roster.unread") : null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        onPress={() => openConversation({ _tag: "bot", botId: bot.id })}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        className="h-(--layout-row-touch) flex-row items-center gap-3 rounded-lg px-2 active:bg-muted"
      >
        <LiveBotAvatar
          bot={bot}
          unread={item.unread}
          lastEntry={item.lastEntry}
          size={40}
          ground={pressed ? "muted" : "background"}
          markPrimary
        />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-medium text-foreground">
          {name}
        </Text>
        {item.unread && <View className="size-2 rounded-pill bg-accent" />}
      </PressScale>
      <Button
        variant="secondary"
        label={t("roster.unhide")}
        accessibilityLabel={t("roster.hidden.unhideName", { name })}
        onPress={() => placing.unhide(bot)}
      />
    </View>
  );
}
