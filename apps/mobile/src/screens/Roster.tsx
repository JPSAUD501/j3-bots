// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  filterRoster,
  orderRoster,
  ROOM_MEMBERS,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import { rosterRows } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { RosterItemKey } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Plus, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Connecting, ConnectionLine } from "../components/ConnectionLine.tsx";
import { FirstRun } from "../components/FirstRun.tsx";
import { Icon } from "../components/Icon.tsx";
import { RosterRow } from "../components/RosterRow.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useI18n } from "../i18n.ts";
import { useSideBySide } from "../layout.ts";
import { asItWas, type Navigation, type Screens, useOpenConversation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { useColor } from "../theme.ts";
import { useNotificationTaps } from "../notificationTaps.ts";
import { Body, Centered, Title } from "../ui.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "roster">;

/**
 * Every bot and room, in the roster's order; one opens its conversation. From
 * the tablet width up, the conversation `item` names sits beside the roster;
 * folded to a phone's width, it moves to its own screen, and what was open
 * over it stays open. The roster is under every other screen, so a tapped
 * push opens its conversation from here.
 */
export function RosterScreen({ navigation, route }: Props) {
  const roster = useReadable(useJ3Client().roster);
  const sideBySide = useSideBySide();
  useNotificationTaps(useOpenConversation());
  const selected = route.params?.item ?? null;
  useEffect(() => {
    if (sideBySide || selected === null) return;
    // The conversation goes on its own screen, under what was open over it.
    const [roster, ...above] = navigation.getState().routes;
    if (roster === undefined) return;
    navigation.reset({
      index: above.length + 1,
      routes: [
        { key: roster.key, name: "roster" },
        { name: "conversation", params: { item: selected } },
        ...above.map(asItWas),
      ],
    });
  }, [sideBySide, selected, navigation]);
  // Before the first bot there is nothing to list or open: the first run takes the whole screen.
  if (roster._tag === "ready" && roster.value.length === 0) return <FirstRun />;
  if (!sideBySide) return <RosterList selected={null} />;
  return (
    <View className="flex-1 flex-row bg-background">
      <View className="border-e border-border" style={{ width: layout.rosterWidth }}>
        <RosterList selected={selected} />
      </View>
      <View className="flex-1">
        {selected === null ? (
          <NoSelection />
        ) : (
          <Pane
            key={rosterKeyText(selected)}
            item={selected}
            onOpenDetails={() => navigation.navigate("details", { item: selected })}
            onClose={() => navigation.setParams({ item: undefined })}
          />
        )}
      </View>
    </View>
  );
}

/** The roster's own header, with its search and New, and its rows, under the status bar. */
function RosterList({ selected }: { readonly selected: RosterItemKey | null }) {
  const { t } = useI18n();
  const roster = useReadable(useJ3Client().roster);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Navigation>();
  const bots = useBots();
  const openConversation = useOpenConversation();
  const placeholder = useColor("accent-muted-foreground");
  const [query, setQuery] = useState("");
  const selectedText = selected === null ? null : rosterKeyText(selected);
  if (roster._tag === "loading") return <Connecting />;
  const searching = query.trim() !== "";
  // A search finds hidden bots too, in the order the web lists what it finds.
  const rows = searching
    ? orderRoster(filterRoster(roster.value, query))
    : rosterRows(roster.value);
  const offerNew = () =>
    // A room needs two bots: with fewer, New says so and offers only a bot.
    Alert.alert(
      t("roster.new"),
      bots.size >= ROOM_MEMBERS.min ? undefined : t("roster.newRoom.needsBots"),
      [
        { text: t("roster.new.cancel"), style: "cancel" },
        ...(bots.size >= ROOM_MEMBERS.min
          ? [
              {
                text: t("roster.newRoom"),
                onPress: () => navigation.navigate("roomForm", { form: { _tag: "create" } }),
              },
            ]
          : []),
        { text: t("roster.newBot"), onPress: () => navigation.navigate("newBot") },
      ],
    );
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 ps-4 pe-2 pt-3">
        <Text accessibilityRole="header" className="flex-1 text-xl font-semibold text-foreground">
          {t("roster.label")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("roster.new")}
          onPress={offerNew}
          className="size-11 items-center justify-center rounded-md active:bg-muted"
        >
          <Icon icon={Plus} size={20} color="accent-foreground" />
        </Pressable>
        <SettingsEntry />
      </View>
      <View className="mx-4 my-2 min-h-11 flex-row items-center gap-2 rounded-md bg-muted px-3">
        <Icon icon={Search} size={14} color="accent-muted-foreground" />
        <TextInput
          accessibilityLabel={t("roster.search")}
          value={query}
          onChangeText={setQuery}
          placeholder={t("roster.search")}
          placeholderTextColor={placeholder}
          autoCorrect={false}
          returnKeyType="search"
          className="min-h-11 flex-1 text-base text-foreground"
        />
      </View>
      <ConnectionLine loaded />
      <FlatList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        data={rows}
        keyExtractor={(item) => rosterKeyText(rosterKeyOf(item))}
        ListEmptyComponent={
          <View className="items-center px-6 py-12">
            <Body>
              {searching ? t("roster.noMatch", { query: query.trim() }) : t("roster.empty")}
            </Body>
          </View>
        }
        renderItem={({ item }) => {
          const key = rosterKeyOf(item);
          return (
            <RosterRow
              item={item}
              selected={rosterKeyText(key) === selectedText}
              onOpen={() => openConversation(key)}
            />
          );
        }}
        extraData={selectedText}
      />
    </View>
  );
}

/** The conversation beside the roster. */
function Pane({
  item: key,
  onOpenDetails,
  onClose,
}: {
  readonly item: RosterItemKey;
  readonly onOpenDetails: () => void;
  readonly onClose: () => void;
}) {
  const found = useRosterItem(key);
  const openConversation = useOpenConversation();
  if (found._tag === "loading") return <Connecting />;
  if (found._tag === "gone") return <Gone onBack={onClose} />;
  return (
    <ConversationView
      item={found.item}
      onBack={null}
      onOpenDetails={onOpenDetails}
      onOpenBot={(botId) => openConversation({ _tag: "bot", botId })}
      onGone={onClose}
    />
  );
}

/** Beside the roster, before a conversation is picked. */
function NoSelection() {
  const { t } = useI18n();
  return (
    <Centered>
      <Title>{t("empty.noSelection.title")}</Title>
      <Body>{t("empty.noSelection.body")}</Body>
    </Centered>
  );
}
