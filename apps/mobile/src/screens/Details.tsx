// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { View } from "react-native";
import { Connecting } from "../components/ConnectionLine.tsx";
import { Gone } from "../conversation/ConversationView.tsx";
import { BotDetails } from "../details/BotDetails.tsx";
import { RoomDetails } from "../details/RoomDetails.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useRosterItem } from "./rosterItem.ts";

/** A bot's or room's details, titled "Details": the profile under the title names who. */
export function DetailsScreen({ navigation, route }: NativeStackScreenProps<Screens, "details">) {
  const { t } = useI18n();
  const found = useRosterItem(route.params.item);
  const title = t("conversation.details");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  if (found._tag === "loading") return <Connecting />;
  if (found._tag === "gone") {
    return (
      <View className="flex-1 bg-background">
        <Gone onBack={() => navigation.popTo("roster")} />
      </View>
    );
  }
  return found.item._tag === "bot" ? (
    <BotDetails bot={found.item.bot} />
  ) : (
    <RoomDetails room={found.item.room} />
  );
}
