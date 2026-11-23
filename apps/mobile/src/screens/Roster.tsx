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
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Bot, Plus, Search, SearchX, Users, X } from "lucide-react-native";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { FlatList, type FlatListProps, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { displaySpacing, Text, TextInput } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarHold, AvatarRow, rowsOnScreen } from "../components/avatar/BotAvatar.tsx";
import { Connecting, ConnectionLine } from "../components/ConnectionLine.tsx";
import { Icon } from "../components/Icon.tsx";
import { StateMark } from "../components/States.tsx";
import { Menu, type MenuAnchor, type MenuEntry } from "../components/Menu.tsx";
import {
  ReorderCell,
  ROW_HEIGHT,
  RowLift,
  RowMoves,
  useKeptPlace,
  useRowMotion,
} from "../components/Reorder.tsx";
import { RosterRow } from "../components/RosterRow.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useI18n } from "../i18n.ts";
import { Onboarding } from "../onboarding/Onboarding.tsx";
import { useSideBySide } from "../layout.ts";
import { asItWas, type Navigation, type Screens, useOpenConversation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
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
  const openConversation = useOpenConversation();
  useNotificationTaps(openConversation);
  const selected = route.params?.item ?? null;
  // The first bot's conversation opens straight from the first run: the first run stays from the
  // press of Create until the conversation covers the roster, or opens beside it, so the roster
  // never shows in between.
  const [openingFirstBot, setOpeningFirstBot] = useState(false);
  const openedBeside =
    sideBySide &&
    selected !== null &&
    roster._tag === "ready" &&
    roster.value.some((item) => rosterKeyText(rosterKeyOf(item)) === rosterKeyText(selected));
  if (openingFirstBot && openedBeside) setOpeningFirstBot(false);
  useEffect(() => {
    if (!openingFirstBot) return;
    // Once the conversation pushed over it is in place, or the roster is shown again.
    const covered = navigation.addListener("transitionEnd", () => setOpeningFirstBot(false));
    const shown = navigation.addListener("focus", () => setOpeningFirstBot(false));
    return () => {
      covered();
      shown();
    };
  }, [openingFirstBot, navigation]);
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
  if ((roster._tag === "ready" && roster.value.length === 0) || openingFirstBot) {
    return (
      <Onboarding
        onCreating={setOpeningFirstBot}
        onArrived={(botId) => openConversation({ _tag: "bot", botId })}
      />
    );
  }
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

/** A row counts as on screen, and its avatar moves, once any of it shows. */
const ON_SCREEN: FlatListProps<RosterItem>["viewabilityConfig"] = {
  itemVisiblePercentThreshold: 1,
};

type Viewable = NonNullable<FlatListProps<RosterItem>["onViewableItemsChanged"]>;

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
  // New's menu opens under its button, measured as it opens.
  const newButton = useRef<ComponentRef<typeof View>>(null);
  const [newAt, setNewAt] = useState<MenuAnchor | null>(null);
  const sideBySide = useSideBySide();
  const selectedText = selected === null ? null : rosterKeyText(selected);
  // The rows on screen, by key; the others' avatars hold still. Stable, as the list requires.
  const [onScreen] = useState(rowsOnScreen);
  const onViewable = useCallback<Viewable>(
    ({ viewableItems }) => onScreen.set(new Set(viewableItems.map((token) => token.key))),
    [onScreen],
  );
  // The avatars hold while the list scrolls, from the drag through its glide.
  const scrolling = useSharedValue(false);
  const list = useRef<FlatList<RosterItem>>(null);
  // How far the list is scrolled, which keeps the rows in view where they are as rows move.
  const scrolled = useSharedValue(0);
  const searched = query.trim();
  const searching = searched !== "";
  // A search finds hidden bots too, in the order the web lists what it finds.
  const rows =
    roster._tag === "loading"
      ? null
      : searching
        ? orderRoster(filterRoster(roster.value, query))
        : rosterRows(roster.value);
  const motion = useRowMotion(
    rows === null
      ? null
      : { keys: rows.map((item) => rosterKeyText(rosterKeyOf(item))), query: searched },
  );
  useKeptPlace(list, motion, scrolled);
  if (rows === null) return <Connecting />;
  const newEntries: ReadonlyArray<MenuEntry> = [
    { label: t("roster.newBot"), icon: Bot, onPress: () => navigation.navigate("newBot") },
    // A room needs two bots: with fewer, the row says so and makes a bot instead.
    bots.size >= ROOM_MEMBERS.min
      ? {
          label: t("roster.newRoom"),
          icon: Users,
          onPress: () => navigation.navigate("roomForm", { form: { _tag: "create" } }),
        }
      : {
          label: t("roster.newRoom"),
          icon: Users,
          hint: t("roster.newRoom.needsBots"),
          onPress: () => navigation.navigate("newBot"),
        },
  ];
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 ps-4 pe-2 pt-3">
        {/* Alone on a phone the roster is titled; beside a conversation it needs no title. */}
        {sideBySide ? (
          <View className="flex-1" />
        ) : (
          <Text
            accessibilityRole="header"
            face="display"
            className="flex-1 text-3xl text-foreground"
            style={{ letterSpacing: displaySpacing(30) }}
          >
            {t("roster.label")}
          </Text>
        )}
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("roster.new")}
          ref={newButton}
          onPress={() =>
            newButton.current?.measureInWindow((x, y, width, height) =>
              setNewAt({ x, y, width, height }),
            )
          }
          className="size-11 items-center justify-center rounded-pill active:bg-muted"
        >
          <Icon icon={Plus} size={22} color="accent-foreground" />
        </PressScale>
        <SettingsEntry />
      </View>
      <Menu
        anchor={newAt}
        onClose={() => setNewAt(null)}
        label={t("roster.new")}
        entries={newEntries}
      />
      <View className="mx-4 mt-2 mb-3 min-h-11 flex-row items-center gap-2 rounded-md bg-muted px-3">
        <Icon icon={Search} size={16} color="accent-muted-foreground" />
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
        {searching && (
          <PressScale
            depth="round"
            accessibilityRole="button"
            accessibilityLabel={t("roster.search.clear")}
            onPress={() => setQuery("")}
            hitSlop={8}
            className="size-7 items-center justify-center rounded-pill"
          >
            <Icon icon={X} size={16} color="accent-muted-foreground" />
          </PressScale>
        )}
      </View>
      <ConnectionLine loaded />
      <AvatarHold held={scrolling}>
        <RowMoves motion={motion} scrolled={scrolled}>
          <FlatList
            ref={list}
            className="flex-1"
            contentContainerStyle={{ paddingBottom: insets.bottom }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            data={rows}
            keyExtractor={(item) => rosterKeyText(rosterKeyOf(item))}
            ListEmptyComponent={
              <View className="items-center gap-3 px-6 py-12">
                <StateMark icon={searching ? SearchX : Bot} />
                <Body>
                  {searching ? t("roster.noMatch", { query: query.trim() }) : t("roster.empty")}
                </Body>
              </View>
            }
            CellRendererComponent={ReorderCell}
            getItemLayout={(_, index) => ({
              length: ROW_HEIGHT,
              offset: ROW_HEIGHT * index,
              index,
            })}
            renderItem={({ item }) => {
              const key = rosterKeyOf(item);
              const text = rosterKeyText(key);
              const selected = text === selectedText;
              return (
                <AvatarRow rows={onScreen} rowKey={text}>
                  <RowLift rowKey={text} selected={selected}>
                    {(avatar) => (
                      <RosterRow
                        item={item}
                        selected={selected}
                        avatarRef={avatar}
                        onOpen={() => openConversation(key)}
                      />
                    )}
                  </RowLift>
                </AvatarRow>
              );
            }}
            scrollEventThrottle={16}
            onScroll={(event) => scrolled.set(event.nativeEvent.contentOffset.y)}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={ON_SCREEN}
            extraData={selectedText}
            onScrollBeginDrag={() => scrolling.set(true)}
            onScrollEndDrag={() => scrolling.set(false)}
            onMomentumScrollBegin={() => scrolling.set(true)}
            onMomentumScrollEnd={() => scrolling.set(false)}
          />
        </RowMoves>
      </AvatarHold>
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
