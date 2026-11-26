// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { RosterItem } from "@j3-bots/contracts";
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
import { hiddenItems, itemName } from "./rosterItem.ts";

const slide = reanimatedSpring(springs.slide);
const closing = LinearTransition.springify()
  .mass(slide.mass)
  .stiffness(slide.stiffness)
  .damping(slide.damping);

/**
 * The bots and rooms the operator hid, by name, each with Show; one with
 * something unread carries a dot. A row opens the conversation or the room,
 * which stays as it was while hidden. One shown again fades away as the rest
 * close up, and returns to the roster where it belongs; with none left the
 * screen says that hiding keeps a conversation working.
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
  const hidden = hiddenItems(roster.value);
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
              key={rosterKeyText(rosterKeyOf(item))}
              exiting={FadeOut.duration(motion.state)}
              layout={closing}
            >
              <HiddenItem item={item} />
            </Animated.View>
          ))
        )}
      </LayoutAnimationConfig>
    </ScrollView>
  );
}

/** A hidden bot or room: its avatar and name, a dot while something of it is unread, and Show. */
function HiddenItem({ item }: { readonly item: RosterItem }) {
  const { t } = useI18n();
  const botPlacing = useBotPlacing();
  const roomPlacing = useRoomPlacing();
  const openConversation = useOpenConversation();
  const bots = useBots();
  const name = itemName(item);
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
          item.unread ? t("roster.unread") : null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        onPress={() => openConversation(rosterKeyOf(item))}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        className="h-(--layout-row-touch) flex-row items-center gap-3 rounded-lg px-2 active:bg-muted"
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
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-medium text-foreground">
          {name}
        </Text>
        {item.unread && <View className="size-2 rounded-pill bg-accent" />}
      </PressScale>
      <Button
        variant="secondary"
        label={t("roster.unhide")}
        accessibilityLabel={t("roster.hidden.unhideName", { name })}
        onPress={() =>
          item._tag === "bot" ? botPlacing.unhide(item.bot) : roomPlacing.unhide(item.room)
        }
      />
    </View>
  );
}
