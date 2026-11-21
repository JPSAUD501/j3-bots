// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { View } from "react-native";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useSideBySide } from "../layout.ts";
import { type Screens, useOpenConversation } from "../navigation.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "conversation">;

/**
 * A bot's or room's conversation on its own screen, on a phone. Unfolded to
 * the tablet width, it moves beside the roster.
 */
export function ConversationScreen({ navigation, route }: Props) {
  const key = route.params.item;
  const item = useRosterItem(key);
  const sideBySide = useSideBySide();
  const openConversation = useOpenConversation();
  useEffect(() => {
    if (sideBySide) navigation.popTo("roster", { item: key });
  }, [sideBySide, navigation, key]);
  if (item === null) {
    return (
      <View className="flex-1 bg-background">
        <Gone onBack={() => navigation.popTo("roster")} />
      </View>
    );
  }
  return (
    <ConversationView
      key={rosterKeyText(rosterKeyOf(item))}
      item={item}
      onBack={navigation.goBack}
      onOpenDetails={() => navigation.navigate("details", { item: key })}
      onOpenBot={(botId) => openConversation({ _tag: "bot", botId })}
      onGone={() => navigation.popTo("roster")}
    />
  );
}
