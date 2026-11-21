// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItemKey } from "@j3-bots/contracts";
import type {
  NativeStackNavigationOptions,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { Button } from "../ui.tsx";
import { itemName, useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "conversation">;

function DetailsButton(props: { readonly item: RosterItemKey; readonly onPress: () => void }) {
  const { t } = useI18n();
  const item = useRosterItem(props.item);
  return (
    <Button
      label={t("conversation.details")}
      accessibilityLabel={t("conversation.openDetails", {
        name: item === null ? "" : itemName(item),
      })}
      onPress={props.onPress}
    />
  );
}

/** The conversation's header: Details, at its end, opens the bot's or room's details. */
export const conversationOptions = ({
  navigation,
  route,
}: Props): NativeStackNavigationOptions => ({
  headerRight: () => (
    <DetailsButton
      item={route.params.item}
      onPress={() => navigation.navigate("details", { item: route.params.item })}
    />
  ),
});

/** A bot's or room's conversation, under its name. */
export function ConversationScreen({ navigation, route }: Props) {
  const item = useRosterItem(route.params.item);
  const name = item === null ? "" : itemName(item);
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  return <View className="flex-1 bg-background" />;
}
