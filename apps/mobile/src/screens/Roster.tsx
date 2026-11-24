// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  arrangeRoster,
  type BotItem,
  filterRoster,
  orderRoster,
  ROOM_MEMBERS,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { RosterItemKey, Section } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bot,
  ChevronRight,
  FileInput,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
  Users,
  X,
} from "lucide-react-native";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { FlatList, type FlatListProps, useWindowDimensions, View } from "react-native";
import { useAnimatedRef, useSharedValue } from "react-native-reanimated";
import { displaySpacing, Text, TextInput } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarHold, AvatarRow, rowsOnScreen } from "../components/avatar/BotAvatar.tsx";
import { Connecting, ConnectionLine } from "../components/ConnectionLine.tsx";
import { Icon } from "../components/Icon.tsx";
import { StateMark } from "../components/States.tsx";
import { BotMenu, type PressedBot } from "../components/BotMenu.tsx";
import { Menu, type MenuAnchor, type MenuEntry } from "../components/Menu.tsx";
import { PinnedBots } from "../components/PinnedBots.tsx";
import {
  ReorderCell,
  RowLift,
  RowMoves,
  rowLayout,
  useKeptPlace,
  useRowMotion,
} from "../components/Reorder.tsx";
import { RosterRow } from "../components/RosterRow.tsx";
import { SectionEmpty, SectionHeader } from "../components/SectionHeader.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { UpdateNotice } from "../update/UpdateNotice.tsx";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useI18n } from "../i18n.ts";
import { Onboarding } from "../onboarding/Onboarding.tsx";
import { useSideBySide } from "../layout.ts";
import { asItWas, type Navigation, type Screens, useOpenConversation } from "../navigation.tsx";
import { pickTemplate } from "../template/opened.ts";
import { useBots } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { useColor } from "../theme.ts";
import { useNotificationTaps } from "../notificationTaps.ts";
import { Body, Centered, Title } from "../ui.tsx";
import { useTextLines } from "../lines.tsx";
import { toggleFolded, useFolded } from "./folded.ts";
import { useSectionActions } from "./placing.ts";
import { useRosterItem } from "./rosterItem.ts";
import { foundEntries, type RosterEntry, rosterEntries, rosterSizes } from "./rosterEntries.ts";

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
        onArrived={(botId) => openConversation({ _tag: "bot", botId }, true)}
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
const ON_SCREEN: FlatListProps<RosterEntry>["viewabilityConfig"] = {
  itemVisiblePercentThreshold: 1,
};

type Viewable = NonNullable<FlatListProps<RosterEntry>["onViewableItemsChanged"]>;

/** A section whose header the operator long-pressed, and where that header is. */
interface PressedSection {
  readonly section: Section;
  readonly count: number;
  readonly unread: boolean;
  readonly folded: boolean;
  readonly anchor: MenuAnchor;
}

/**
 * The roster's own header, with its search and New, and under it, under the
 * status bar, what the operator arranged: the pinned bots as a band of large
 * avatars, then the rows in no section, then each section, then the way to
 * the hidden bots. A search lists only what matches, hidden bots too, as
 * rows. A long press on a bot or a section's header opens its menu.
 */
function RosterList({ selected }: { readonly selected: RosterItemKey | null }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const roster = useReadable(client.roster);
  const sections = useReadable(client.sections);
  const folded = useFolded();
  const sectionActions = useSectionActions();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Navigation>();
  const bots = useBots();
  const windowWidth = useWindowDimensions().width;
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
  const list = useAnimatedRef<FlatList<RosterEntry>>();
  // How far the list is scrolled, which keeps the rows in view where they are as rows move.
  const scrolled = useSharedValue(0);
  const searched = query.trim();
  const searching = searched !== "";
  // Beside a conversation the roster is its column's width.
  const width = sideBySide ? layout.rosterWidth : windowWidth;
  // A search finds hidden bots too, in the order the web lists what it finds.
  // Each entry is as tall as its text needs at the operator's font size, once the lines are read.
  const lines = useTextLines();
  const sizes = lines === null ? null : rosterSizes(lines);
  const entries =
    roster._tag === "loading" || sizes === null
      ? null
      : searching
        ? foundEntries(orderRoster(filterRoster(roster.value, query)), sizes)
        : rosterEntries(
            arrangeRoster(orderRoster(roster.value), sections ?? []),
            width,
            folded,
            sizes,
          );
  const motion = useRowMotion(entries === null ? null : { rows: entries, query: searched });
  const keeping = useKeptPlace(list, motion, scrolled);
  // The bot whose menu is open, and the rows the operator just moved out of the list, which fade
  // away as they go; a row the list no longer has needs nothing more.
  const [pressed, setPressed] = useState<PressedBot | null>(null);
  const [pressedSection, setPressedSection] = useState<PressedSection | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const listed = new Set(entries?.map((entry) => entry.key));
  if ([...leaving].some((key) => !listed.has(key))) {
    setLeaving(new Set([...leaving].filter((key) => listed.has(key))));
  }
  if (entries === null) return <Connecting />;
  const openBot = (item: BotItem) => openConversation({ _tag: "bot", botId: item.bot.id });
  // Folding a section fades its rows out as the rows under it close up; opening it, they fade in.
  const fold = (section: Section) => {
    if (!folded.has(section.id)) {
      const at = entries.findIndex((entry) => entry.key === `section:${section.id}`);
      const next = entries.findIndex(
        (entry, index) => index > at && entry.kind !== "row" && entry.kind !== "empty",
      );
      const inside = entries.slice(at + 1, next === -1 ? undefined : next);
      setLeaving((now) => new Set([...now, ...inside.map((entry) => entry.key)]));
    }
    toggleFolded(
      section.id,
      (sections ?? []).map((each) => each.id),
    );
  };
  const sectionEntries: ReadonlyArray<MenuEntry> =
    pressedSection === null
      ? []
      : [
          {
            label: t("roster.section.rename"),
            icon: Pencil,
            onPress: () => sectionActions.rename(pressedSection.section),
          },
          {
            label: t("roster.section.delete"),
            icon: Trash2,
            tone: "destructive",
            onPress: () => sectionActions.remove(pressedSection.section),
          },
        ];
  const newEntries: ReadonlyArray<MenuEntry> = [
    { label: t("roster.newBot"), icon: Bot, onPress: () => navigation.navigate("newBot") },
    { label: t("roster.newFromTemplate"), icon: FileInput, onPress: () => void pickTemplate() },
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
      <UpdateNotice />
      <BotMenu
        pressed={pressed}
        onClose={() => setPressed(null)}
        onLeave={(item) => setLeaving((now) => new Set(now).add(rosterKeyText(rosterKeyOf(item))))}
      />
      <Menu
        anchor={pressedSection?.anchor ?? null}
        onClose={() => setPressedSection(null)}
        label={
          pressedSection === null
            ? ""
            : t("roster.section.menu", { section: pressedSection.section.name })
        }
        entries={sectionEntries}
        edge="start"
        width={224}
        {...(pressedSection === null
          ? {}
          : {
              preview: (
                <SectionHeader
                  section={pressedSection.section}
                  height={pressedSection.anchor.height}
                  count={pressedSection.count}
                  unread={pressedSection.unread}
                  folded={pressedSection.folded}
                  lifted
                />
              ),
            })}
      />
      <AvatarHold held={scrolling}>
        <RowMoves motion={motion} keeper={keeping.keeper} leaving={leaving}>
          <FlatList
            ref={list}
            className="flex-1"
            contentContainerStyle={{ paddingBottom: insets.bottom }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            data={entries}
            keyExtractor={(entry) => entry.key}
            ListEmptyComponent={
              <View className="items-center gap-3 px-6 py-12">
                <StateMark icon={searching ? SearchX : Bot} />
                <Body>
                  {searching ? t("roster.noMatch", { query: query.trim() }) : t("roster.empty")}
                </Body>
              </View>
            }
            CellRendererComponent={ReorderCell}
            // Android detaches rows laid out off screen by where they end up,
            // so a row travelling across the view from above it to below it
            // would never be drawn on the way.
            removeClippedSubviews={false}
            getItemLayout={rowLayout(entries)}
            renderItem={({ item: entry }) => {
              switch (entry.kind) {
                case "pinned":
                  return (
                    <AvatarRow rows={onScreen} rowKey={entry.key}>
                      <PinnedBots
                        bots={entry.bots}
                        columns={entry.columns}
                        width={width}
                        height={entry.height}
                        cell={entry.cell}
                        selectedKey={selectedText}
                        onOpen={openBot}
                        onMenu={(item, anchor) => setPressed({ item, from: "pinned", anchor })}
                      />
                    </AvatarRow>
                  );
                case "row": {
                  const { item } = entry;
                  const key = rosterKeyOf(item);
                  const selected = entry.key === selectedText;
                  return (
                    <AvatarRow rows={onScreen} rowKey={entry.key}>
                      <RowLift rowKey={entry.key} selected={selected}>
                        {(avatar) => (
                          <RosterRow
                            item={item}
                            height={entry.height}
                            selected={selected}
                            avatarRef={avatar}
                            onOpen={() => openConversation(key)}
                            {...(item._tag === "bot"
                              ? {
                                  onMenu: (anchor: MenuAnchor) =>
                                    setPressed({ item, from: "row", anchor }),
                                }
                              : {})}
                          />
                        )}
                      </RowLift>
                    </AvatarRow>
                  );
                }
                case "section":
                  return (
                    <SectionHeader
                      section={entry.section}
                      height={entry.height}
                      count={entry.count}
                      unread={entry.unread}
                      folded={entry.folded}
                      onToggle={() => fold(entry.section)}
                      onMenu={(anchor) =>
                        setPressedSection({
                          section: entry.section,
                          count: entry.count,
                          unread: entry.unread,
                          folded: entry.folded,
                          anchor,
                        })
                      }
                    />
                  );
                case "empty":
                  return <SectionEmpty height={entry.height} />;
                case "hidden":
                  return (
                    <HiddenRow
                      bots={entry.bots}
                      height={entry.height}
                      onOpen={() => navigation.navigate("hidden")}
                    />
                  );
              }
            }}
            scrollEventThrottle={16}
            onScroll={(event) => scrolled.set(event.nativeEvent.contentOffset.y)}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={ON_SCREEN}
            extraData={selectedText}
            onScrollBeginDrag={() => {
              // The operator takes the list: it stops gliding to keep its place.
              keeping.stop();
              scrolling.set(true);
            }}
            onScrollEndDrag={() => scrolling.set(false)}
            onMomentumScrollBegin={() => scrolling.set(true)}
            onMomentumScrollEnd={() => scrolling.set(false)}
          />
        </RowMoves>
      </AvatarHold>
    </View>
  );
}

/**
 * The way to the hidden bots, at the end of the list: how many there are,
 * and a chevron to the screen that lists them.
 */
function HiddenRow({
  bots,
  height,
  onOpen,
}: {
  readonly bots: ReadonlyArray<BotItem>;
  readonly height: number;
  readonly onOpen: () => void;
}) {
  const { t, plural } = useI18n();
  const count = bots.length;
  const unread = bots.some((item) => item.unread);
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={[plural("roster.hidden.count", count), unread ? t("roster.unread") : null]
        .filter((part) => part !== null)
        .join(", ")}
      onPress={onOpen}
      className="mx-2 flex-row items-center gap-2 rounded-lg px-3 active:bg-muted"
      style={{ height }}
    >
      <Text className="text-base text-muted-foreground">{t("roster.hidden")}</Text>
      {unread && <View className="size-2 rounded-pill bg-accent" />}
      <Text className="text-base text-muted-foreground">{count}</Text>
      <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
    </PressScale>
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
