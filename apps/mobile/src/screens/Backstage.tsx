// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { RosterItem } from "@j3-bots/contracts";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Theater } from "lucide-react-native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoomAvatar, roomAvatarMembers } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import { StateMark } from "../components/States.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useOpenConversation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Body, Button } from "../ui.tsx";
import { useBotPlacing, useRoomPlacing } from "./placing.ts";
import { backstageItems, itemName } from "./rosterItem.ts";

const slide = reanimatedSpring(springs.slide);
const closing = LinearTransition.springify()
  .mass(slide.mass)
  .stiffness(slide.stiffness)
  .damping(slide.damping);

/**
 * The bots and rooms the operator moved behind the scenes, by name, a bot
 * over its title, each with Bring back to the list; one with something
 * unread carries a dot. A row opens the conversation or the room, which stays
 * as it was behind the scenes. One brought back fades away as the rest close
 * up, and returns to the roster where it belongs; with none left the screen
 * says there is nothing behind the scenes.
 */
export function BackstageScreen({ navigation }: NativeStackScreenProps<Screens, "backstage">) {
  const { t } = useI18n();
  const roster = useReadable(useJ3Client().roster);
  const insets = useSafeAreaInsets();
  const title = t("backstage.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  if (roster._tag === "loading") return <Connecting />;
  const items = backstageItems(roster.value);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ flexGrow: 1, paddingTop: 8, paddingBottom: insets.bottom + 24 }}
    >
      {/* What was there as the screen opened appears in place; only what changes moves. */}
      <LayoutAnimationConfig skipEntering>
        {items.length === 0 ? (
          <Animated.View
            entering={FadeIn.duration(motion.state)}
            className="flex-1 items-center justify-center gap-3 px-8"
          >
            <StateMark icon={Theater} />
            <Body>{t("backstage.empty")}</Body>
          </Animated.View>
        ) : (
          items.map((item) => (
            <Animated.View
              key={rosterKeyText(rosterKeyOf(item))}
              exiting={FadeOut.duration(motion.state)}
              layout={closing}
            >
              <BackstageItem item={item} />
            </Animated.View>
          ))
        )}
      </LayoutAnimationConfig>
    </ScrollView>
  );
}

/**
 * A bot or room behind the scenes: its avatar, its name and a bot's title, a
 * dot while something of it is unread, and Bring back to the list.
 */
function BackstageItem({ item }: { readonly item: RosterItem }) {
  const { t } = useI18n();
  const botPlacing = useBotPlacing();
  const roomPlacing = useRoomPlacing();
  const openConversation = useOpenConversation();
  const bots = useBots();
  const name = itemName(item);
  const title = item._tag === "bot" ? item.bot.profile.title : "";
  const primary = item._tag === "bot" && item.bot.primary;
  const [pressed, setPressed] = useState(false);
  const ground = pressed ? "muted" : "background";
  return (
    <View className="mx-2 flex-row items-center gap-2 pe-2">
      <PressScale
        depth="row"
        frame={{ flex: 1, minWidth: 0 }}
        accessibilityRole="button"
        accessibilityLabel={[
          name,
          primary ? t("roster.primary") : null,
          title === "" ? null : title,
          item.unread ? t("roster.unread") : null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        onPress={() => openConversation(rosterKeyOf(item))}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        className="min-h-(--layout-row-touch) flex-row items-center gap-3 rounded-lg px-2 py-2 active:bg-muted"
      >
        {item._tag === "bot" ? (
          <LiveBotAvatar
            bot={item.bot}
            unread={item.unread}
            lastEntry={item.lastEntry}
            size={40}
            ground={ground}
            markPrimary
          />
        ) : (
          <RoomAvatar size={40} ground={ground} members={roomAvatarMembers(item.room, bots)} />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base font-medium text-foreground">
            {name}
          </Text>
          {title !== "" && (
            <Text numberOfLines={2} className="text-xs text-muted-foreground">
              {title}
            </Text>
          )}
        </View>
        {item.unread && <View className="size-2 rounded-pill bg-accent" />}
      </PressScale>
      <Button
        variant="secondary"
        label={t("backstage.bringBack")}
        accessibilityLabel={t("backstage.bringBackName", { name })}
        onPress={() =>
          item._tag === "bot" ? botPlacing.bringBack(item.bot) : roomPlacing.bringBack(item.room)
        }
      />
    </View>
  );
}
