// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useRoster } from "@j3-bots/client-runtime/react";
import type { RosterItemKey } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionLine } from "../components/ConnectionLine.tsx";
import { RosterRow } from "../components/RosterRow.tsx";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useI18n } from "../i18n.ts";
import { useSideBySide } from "../layout.ts";
import { type Screens, useOpenConversation } from "../navigation.tsx";
import { Body, Centered, Title } from "../ui.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "roster">;

/**
 * Every bot and room, in the roster's order; one opens its conversation. From
 * the tablet width up, the conversation `item` names sits beside the roster;
 * folded to a phone's width, it moves to its own screen.
 */
export function RosterScreen({ navigation, route }: Props) {
  const sideBySide = useSideBySide();
  const selected = route.params?.item ?? null;
  useEffect(() => {
    if (sideBySide || selected === null) return;
    navigation.setParams({ item: undefined });
    navigation.navigate("conversation", { item: selected });
  }, [sideBySide, selected, navigation]);
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

/** The roster's own header and its rows, under the status bar. */
function RosterList({ selected }: { readonly selected: RosterItemKey | null }) {
  const { t } = useI18n();
  const roster = useRoster();
  const insets = useSafeAreaInsets();
  const openConversation = useOpenConversation();
  const selectedText = selected === null ? null : rosterKeyText(selected);
  if (roster === null) {
    return (
      <Centered>
        <ConnectionLine loaded={false} />
        <Title>{t("firstRun.connecting.title")}</Title>
      </Centered>
    );
  }
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <Text accessibilityRole="header" className="px-4 py-3 text-xl font-semibold text-foreground">
        {t("roster.label")}
      </Text>
      <ConnectionLine loaded />
      <FlatList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom }}
        data={roster.rows}
        keyExtractor={(item) => rosterKeyText(rosterKeyOf(item))}
        ListEmptyComponent={
          <View className="items-center px-6 py-12">
            <Body>{t("roster.empty")}</Body>
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
  const item = useRosterItem(key);
  const openConversation = useOpenConversation();
  if (item === null) return <Gone onBack={onClose} />;
  return (
    <ConversationView
      item={item}
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
