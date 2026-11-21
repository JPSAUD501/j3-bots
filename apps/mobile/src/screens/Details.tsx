// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { View } from "react-native";
import type { Screens } from "../navigation.tsx";
import { itemName, useRosterItem } from "./rosterItem.ts";

/** A bot's or room's details, under its name. */
export function DetailsScreen({ navigation, route }: NativeStackScreenProps<Screens, "details">) {
  const item = useRosterItem(route.params.item);
  const name = item === null ? "" : itemName(item);
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  return <View className="flex-1 bg-background" />;
}
