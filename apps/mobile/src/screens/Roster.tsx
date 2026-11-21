// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client, useRoster } from "@j3-bots/client-runtime/react";
import type { RosterItem } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { Body, Button, Centered, Title } from "../ui.tsx";
import { itemName } from "./rosterItem.ts";

/**
 * One line while the server is out of reach; nothing while connected. Once
 * the roster has loaded, a new attempt to connect is a reconnection.
 */
function ConnectionLine(props: { readonly loaded: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const connection = useConnection();
  if (connection._tag === "offline") {
    return (
      <Text className="px-4 py-2 text-sm text-muted-foreground">{t("connection.offline")}</Text>
    );
  }
  if (connection._tag === "waiting") {
    return (
      <View className="flex-row items-center justify-between gap-2 px-4 py-1">
        <Text className="flex-1 text-sm text-muted-foreground">{t("connection.unreachable")}</Text>
        <Button label={t("connection.retryNow")} onPress={client.reconnectNow} />
      </View>
    );
  }
  if (connection._tag === "connecting" && props.loaded) {
    return (
      <Text className="px-4 py-2 text-sm text-muted-foreground">
        {t("connection.reconnecting")}
      </Text>
    );
  }
  return null;
}

function Row(props: { readonly item: RosterItem; readonly onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      className="min-h-16 justify-center border-b border-border px-4"
    >
      <Text numberOfLines={1} className="text-lg text-foreground">
        {itemName(props.item)}
      </Text>
    </Pressable>
  );
}

/** Every bot and room, in the roster's order; one opens its conversation. */
export function RosterScreen({ navigation }: NativeStackScreenProps<Screens, "roster">) {
  const { t } = useI18n();
  const roster = useRoster();
  const insets = useSafeAreaInsets();
  if (roster === null) {
    return (
      <Centered>
        <ConnectionLine loaded={false} />
        <Title>{t("firstRun.connecting.title")}</Title>
      </Centered>
    );
  }
  return (
    <FlatList
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom }}
      data={roster.rows}
      keyExtractor={(item) => rosterKeyText(rosterKeyOf(item))}
      ListHeaderComponent={<ConnectionLine loaded />}
      ListEmptyComponent={
        <View className="items-center px-6 py-12">
          <Body>{t("roster.empty")}</Body>
        </View>
      }
      renderItem={({ item }) => (
        <Row
          item={item}
          onOpen={() => navigation.navigate("conversation", { item: rosterKeyOf(item) })}
        />
      )}
    />
  );
}
