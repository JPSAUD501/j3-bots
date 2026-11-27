// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MentionLabel, retryAction } from "@j3-bots/client-runtime";
import {
  addressed,
  arrivalCounts,
  buildTimeline,
  type CardPlace,
  cardPlace,
  liveTurn,
  mentionedNames,
  mentionedWhoLeft,
  offeredReply,
  openingHeld,
  type OpeningHold,
  readThrough,
  rosterKeyOf,
  rosterKeyText,
  rosterTarget,
  rowOrder,
  type TeammateRunPair,
  type TimelineItem,
  withLiveTurn,
} from "@j3-bots/client-runtime/presentation";
import {
  useArrivals,
  useConversation,
  useConversationEnd,
  useDraft,
  useEngineStatus,
  useJ3Client,
  useSelected,
} from "@j3-bots/client-runtime/react";
import {
  dividerTime,
  heldHelloText,
  quietConversationText,
  resendLabel,
} from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  BotId,
  BrowserHelpEntry,
  EntryId,
  EntryOrder,
  EntryTarget,
  MessageEntry,
  Mentions,
  Room,
  RosterItem,
  RosterItemKey,
  RoutineId,
} from "@j3-bots/contracts";
import { layout, springs } from "@j3-bots/design-tokens";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type {
  LegendListRef,
  OnViewableItemsChangedInfo,
  ViewabilityConfigCallbackPairs,
} from "@legendapp/list/react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  type ComponentRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SearchX } from "lucide-react-native";
import { AppState, View } from "react-native";
import Animated from "react-native-reanimated";
import { Text } from "../text.tsx";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoomAvatar, roomAvatarMembers } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { AiConnect } from "../components/AiConnect.tsx";
import { PendingButton } from "../components/form.tsx";
import { StateMark } from "../components/States.tsx";
import type { Navigation } from "../navigation.tsx";
import { useRoomActions } from "../details/actions.ts";
import { enteringWhen, openIn, popIn, settleIn, useReducedMotion } from "../motion.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { useSay } from "../toast.tsx";
import { Body, Button, Centered, Title } from "../ui.tsx";
import { Card } from "./Card.tsx";
import { Composer, type MentionCandidate } from "./Composer.tsx";
import { ConversationHeader } from "./Header.tsx";
import { MessageBubble } from "./MessageBubble.tsx";
import { AnimatedView } from "./animated.ts";
import { AnsweringLine } from "./AnsweringLine.tsx";
import { RoomWork } from "./RoomWork.tsx";
import { EventLine } from "./EventLine.tsx";
import { NeedsUpdateLine, NoticeLine } from "./NoticeLine.tsx";
import { Reactions } from "./Reactions.tsx";
import { ToLatest } from "./ToLatest.tsx";
import { conversationVisuals, ConversationVisualsContext } from "./visuals.ts";
import { EntryWidths } from "./widths.ts";
import { ConnectorApps } from "./ConnectorAppCard.tsx";
import { type TurnBot, WorkFold } from "./WorkFold.tsx";

/** Whether the app is in the foreground. */
function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * Whether the operator can see the conversation: its screen has the focus
 * and the app is in the foreground.
 */
function useInView(): boolean {
  const focused = useIsFocused();
  const active = useAppActive();
  return focused && active;
}

/**
 * An entry counts as seen once half of it shows or, taller than the
 * conversation, once it covers half of the conversation's height, as on the
 * web.
 */
const SEEN_PERCENT = 50;

/** The room the pill over the conversation's end takes: its 44 dp and the 8 dp under it. */
const PILL_ROOM = 52;

/**
 * Marks read through the latest entry the operator can see, and tells the server the
 * conversation is in view, while it is `inView`. Otherwise what arrives
 * notifies and stays unread. Returns the list's viewability pairs, which
 * never change.
 */
function useReadMark(
  target: EntryTarget,
  rows: ReadonlyArray<TimelineItem>,
  markRead: (order: EntryOrder) => void,
  inView: boolean,
): ViewabilityConfigCallbackPairs<TimelineItem> {
  const client = useJ3Client();
  // The list reads its viewability callbacks once: they reach what is current through here.
  const latest = useRef({ inView, rows, markRead });
  useLayoutEffect(() => {
    latest.current = { inView, rows, markRead };
  });
  const pairs = useMemo(() => {
    // The rows each rule finds shown now, by key.
    const seen: Record<"half" | "covering", ReadonlySet<string>> = {
      half: new Set(),
      covering: new Set(),
    };
    const report = () => {
      const { inView: shown, rows: now, markRead: mark } = latest.current;
      if (!shown) return;
      const { half, covering } = seen;
      const order = readThrough(
        now.filter((row) => half.has(row.key) || covering.has(row.key)).map(rowOrder),
      );
      if (order !== null) mark(order);
    };
    const follow =
      (which: "half" | "covering") =>
      ({ viewableItems }: OnViewableItemsChangedInfo<TimelineItem>) => {
        seen[which] = new Set(viewableItems.map((token) => token.key));
        report();
      };
    return {
      report,
      pairs: [
        {
          viewabilityConfig: { id: "half", itemVisiblePercentThreshold: SEEN_PERCENT },
          onViewableItemsChanged: follow("half"),
        },
        {
          viewabilityConfig: { id: "covering", viewAreaCoveragePercentThreshold: SEEN_PERCENT },
          onViewableItemsChanged: follow("covering"),
        },
      ],
    };
  }, []);

  useEffect(() => {
    if (!inView) return;
    client.setView(target);
    // What shows as the conversation comes into view is read now.
    pairs.report();
    return () => client.setView(null);
  }, [client, inView, target, pairs]);

  return pairs.pairs;
}

/**
 * Where the card of `entryId` is against what the conversation shows, by the
 * rules an entry counts as seen by: half of it shows, or it covers half the
 * list. Null while there is no such card, or nothing is known to show yet.
 * Returns the list's viewability pairs too, which never change. The rows
 * shown are followed without drawing the conversation again: only a new
 * place does.
 */
function useCardPlaceInList(
  rows: ReadonlyArray<TimelineItem>,
  entryId: EntryId | null,
): {
  readonly place: CardPlace | null;
  readonly pairs: ViewabilityConfigCallbackPairs<TimelineItem>;
} {
  const [place, setPlace] = useState<CardPlace | null>(null);
  // The list reads its viewability callbacks once: they reach what is current through here.
  const latest = useRef({ rows, entryId });
  const follow = useMemo(() => {
    const seen: Record<"half" | "covering", ReadonlySet<string>> = {
      half: new Set(),
      covering: new Set(),
    };
    const place = () => {
      const { rows: now, entryId: card } = latest.current;
      setPlace(
        card === null ? null : cardPlace(now, new Set([...seen.half, ...seen.covering]), card),
      );
    };
    const pair =
      (which: "half" | "covering") =>
      ({ viewableItems }: OnViewableItemsChangedInfo<TimelineItem>) => {
        seen[which] = new Set(viewableItems.map((token) => token.key));
        place();
      };
    return {
      place,
      pairs: [
        {
          viewabilityConfig: { id: "card-half", itemVisiblePercentThreshold: SEEN_PERCENT },
          onViewableItemsChanged: pair("half"),
        },
        {
          viewabilityConfig: {
            id: "card-covering",
            viewAreaCoveragePercentThreshold: SEEN_PERCENT,
          },
          onViewableItemsChanged: pair("covering"),
        },
      ],
    };
  }, [latest]);
  // A new card, or rows that moved, may put it elsewhere with no change in what shows.
  useLayoutEffect(() => {
    latest.current = { rows, entryId };
    follow.place();
  }, [latest, rows, entryId, follow]);
  return { place, pairs: follow.pairs };
}

/**
 * A bot's or room's conversation: its header, every entry oldest first with
 * the newest at the bottom, and the composer, which rides on the keyboard.
 * Mount one per conversation, keyed by it.
 */
export function ConversationView({
  item,
  onBack,
  onOpenDetails,
  onOpen,
  onGone,
}: {
  readonly item: RosterItem;
  /** On a phone, back to the roster; beside the roster there is none. */
  readonly onBack: (() => void) | null;
  readonly onOpenDetails: () => void;
  /**
   * Opens another conversation: a bot's own, as a notice in a room offers, or
   * the room a bot's team line names.
   */
  readonly onOpen: (key: RosterItemKey) => void;
  /** Leaves a conversation whose bot or room was deleted. */
  readonly onGone: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const say = useSay();
  const bots = useBots();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Navigation>();
  // Mounted per conversation: the target stays the one it opened with.
  const [target] = useState(() => rosterTarget(rosterKeyOf(item)));
  /** A routine's runs, over its bot's details, which list it with the bot's other routines. */
  const openBrowser = (card: BrowserHelpEntry) =>
    navigation.push("browser", { botId: card.author.botId, ref: card.tab, help: card.id });
  const openRoutine = (routineId: RoutineId) => {
    onOpenDetails();
    if (target._tag === "conversation") {
      navigation.navigate("routineRuns", { botId: target.botId, routineId });
    }
  };
  /** A run of teammate messages opens their conversation at the run's first message with that teammate. */
  const openPair = (pair: TeammateRunPair) =>
    navigation.push("pair", { botIds: pair.botIds, at: pair.first });
  const { state, loadOlder, markRead } = useConversation(target);
  // In a bot's conversation, its turn under way shows in the timeline, once.
  const bot = item._tag === "bot" ? item.bot : null;
  const turn = useMemo(() => (bot === null ? null : liveTurn(bot)), [bot]);
  const rows = useMemo(
    () => withLiveTurn(buildTimeline(state?.items ?? []), turn),
    [state?.items, turn],
  );
  const folds = useMemo(
    () => (state?.items ?? []).flatMap((entry) => (entry._tag === "work-fold" ? [entry] : [])),
    [state?.items],
  );
  const lastEntry = item._tag === "bot" ? item.lastEntry : null;
  // One object while the bot and its latest entry stay, so the list's rows are not all drawn again.
  const turnBot = useMemo(() => (bot === null ? null : { bot, lastEntry }), [bot, lastEntry]);
  const inView = useInView();
  const readPairs = useReadMark(target, rows, markRead, inView);
  // The card the bot waits on, which the end of the conversation leads to while it is out of view.
  const waitingOn = bot?.state._tag === "waiting" ? bot.state.entryId : null;
  const waiting = useCardPlaceInList(rows, waitingOn);
  // While it does, the pill stands over the end: the list keeps its last entry clear of it.
  const toCard = waiting.place === "above" || waiting.place === "below";
  // The list reads its viewability pairs once: both parts never change.
  const pairs = useMemo(() => [...readPairs, ...waiting.pairs], [readPairs, waiting.pairs]);
  // What arrives at the end settles in, and is counted while the operator reads above it.
  const [scope] = useState(() => rosterKeyText(rosterKeyOf(item)));
  const arrived = useArrivals(
    scope,
    rows.map((row) => row.key),
    state?.phase === "ready",
  );

  const list = useRef<LegendListRef>(null);
  const reduced = useReducedMotion();
  const toEnd = useCallback(
    () => void list.current?.scrollToEnd({ animated: !reduced }),
    [reduced],
  );
  const end = useConversationEnd(scope, arrived, arrivalCounts(rows, arrived), toEnd);
  const composer = useRef<ComponentRef<typeof View>>(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    list,
    composer,
  );
  const [composerHeight, setComposerHeight] = useState(0);
  const [column, setColumn] = useState(0);
  // The conversation is mounted once per conversation, and so is what its visuals share.
  const [visuals] = useState(conversationVisuals);
  useEffect(() => visuals.end, [visuals]);
  const widths = useMemo(() => {
    const { max, bubbleShare, cardShare } = layout.entryWidth;
    return {
      bubble: Math.min(max, column * bubbleShare),
      card: Math.min(max, column * cardShare),
      column,
    };
  }, [column]);

  const room = item._tag === "room" ? item.room : null;
  const engine = useEngineStatus();
  const engineNow = engine._tag === "ready" ? engine.value : null;
  // Kept while the hold reads the same, so the list redraws its rows only when it changes.
  const openingHold = useMemo(
    () => (item._tag === "bot" ? openingHeld(item.bot, engineNow) : null),
    [item, engineNow],
  );

  const draft = useDraft(target);
  // Who the message wakes as the draft stands: only mentions picked, and still standing, count.
  const addressing =
    room === null ? undefined : addressed(draft.text, draft.mentions, room.members);
  const mentionable: ReadonlyArray<MentionCandidate> | undefined = room?.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, name: bot.profile.name, avatar: bot.profile.avatar }];
  });
  const send = () =>
    void client.sendDraft(target, addressing).then((result) => {
      if (result === "not-kept") say(t("composer.notKept"));
    });

  const goTo = (entryId: EntryId) => {
    const index = rows.findIndex((row) => row.kind === "card" && row.entry.id === entryId);
    if (index !== -1)
      void list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  };

  const archived = room !== null && room.status === "archived";
  const quiet = state?.phase === "ready" && state.items.length === 0;

  return (
    <View className="flex-1 bg-background">
      <View style={{ paddingTop: insets.top }}>
        <ConversationHeader
          item={item}
          onBack={onBack}
          onOpenDetails={onOpenDetails}
          folds={folds}
        />
      </View>
      {state?.phase === "not-found" ? (
        <Gone onBack={onGone} />
      ) : (
        <AnimatedView
          entering={openIn()}
          className="flex-1"
          onLayout={(event) =>
            setColumn(Math.min(event.nativeEvent.layout.width, layout.textColumn))
          }
        >
          <ConversationVisualsContext value={visuals}>
            <EntryWidths value={widths}>
              {/* One quick bar, picker and list of who reacted for the conversation's messages. */}
              <Reactions>
                {quiet ? (
                  item._tag === "bot" ? (
                    <Quiet bot={item.bot} bottom={composerHeight} />
                  ) : (
                    <QuietRoom room={item.room} bottom={composerHeight} />
                  )
                ) : (
                  <KeyboardAwareLegendList
                    ref={list}
                    data={rows}
                    keyExtractor={(row) => row.key}
                    getItemType={(row) => row.kind}
                    estimatedItemSize={64}
                    // Rows keep state of their own, such as an open fold: a row is never reused for another.
                    recycleItems={false}
                    renderItem={({ item: row }) => (
                      <View className="w-full self-center" style={{ maxWidth: layout.textColumn }}>
                        <Row
                          row={row}
                          room={room}
                          turnBot={turnBot}
                          arriving={arrived.has(row.key)}
                          openingHold={openingHold}
                          onOpen={onOpen}
                          onOpenRoutine={openRoutine}
                          onOpenBrowser={openBrowser}
                          onOpenPair={openPair}
                        />
                      </View>
                    )}
                    extraData={{ room, widths, arrived, openingHold, turnBot }}
                    onScroll={({
                      nativeEvent: { contentOffset, contentSize, layoutMeasurement },
                    }) => {
                      visuals.scrolled();
                      end.follow(
                        contentSize.height - layoutMeasurement.height - contentOffset.y,
                        layoutMeasurement.height,
                      );
                    }}
                    scrollEventThrottle={64}
                    alignItemsAtEnd
                    initialScrollAtEnd
                    maintainScrollAtEnd
                    maintainVisibleContentPosition
                    onStartReached={() => {
                      if (state?.hasOlder === true && !state.loadingOlder) loadOlder();
                    }}
                    // In a room, who is answering now, after everything said there.
                    ListFooterComponent={
                      room === null ? null : (
                        <View
                          className="w-full self-center"
                          style={{ maxWidth: layout.textColumn }}
                        >
                          <RoomWork room={room} />
                          <AnsweringLine room={room} />
                        </View>
                      )
                    }
                    ListHeaderComponent={
                      state?.loadingOlder === true ? (
                        <Text className="py-3 text-center text-xs text-muted-foreground">
                          {t("timeline.loadingOlder")}
                        </Text>
                      ) : null
                    }
                    viewabilityConfigCallbackPairs={pairs}
                    contentInsetEndAdjustment={contentInsetEndAdjustment}
                    keyboardOffset={insets.bottom}
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{
                      paddingTop: 4,
                      paddingBottom: toCard ? 8 + PILL_ROOM : 8,
                    }}
                  />
                )}
              </Reactions>
            </EntryWidths>
          </ConversationVisualsContext>
          {/* Over the composer, riding on the keyboard with it. */}
          {!quiet && (
            <KeyboardStickyView
              offset={{ closed: 0, opened: insets.bottom }}
              style={{ position: "absolute", start: 0, end: 0, bottom: composerHeight + 8 }}
              pointerEvents="box-none"
            >
              <ToLatest
                end={end}
                onPress={toEnd}
                waiting={
                  waitingOn === null
                    ? null
                    : { place: waiting.place, onPress: () => goTo(waitingOn) }
                }
              />
            </KeyboardStickyView>
          )}
          {/* Over the conversation's end, riding on the keyboard: the list keeps its last entry above it. */}
          <KeyboardStickyView
            offset={{ closed: 0, opened: insets.bottom }}
            style={{ position: "absolute", start: 0, end: 0, bottom: 0 }}
          >
            <View
              ref={composer}
              onLayout={(event) => {
                onComposerLayout(event);
                setComposerHeight(event.nativeEvent.layout.height);
              }}
              className="bg-background"
              style={{ paddingBottom: insets.bottom }}
            >
              <View className="w-full self-center" style={{ maxWidth: layout.textColumn }}>
                {archived ? (
                  <ArchivedLine room={room} />
                ) : (
                  <Composer
                    target={target}
                    recipient={item._tag === "bot" ? item.bot.profile.name : item.room.name}
                    {...(mentionable === undefined ? {} : { mentionable })}
                    onSend={send}
                    inView={inView}
                    tint={item._tag === "bot" ? item.bot.profile.avatar : null}
                    suggestion={
                      item._tag === "bot"
                        ? offeredReply(item.bot.suggestedReply, state?.items ?? [])
                        : null
                    }
                  />
                )}
              </View>
            </View>
          </KeyboardStickyView>
        </AnimatedView>
      )}
    </View>
  );
}

/** Where an archived room's composer was: that it takes no messages, and the way back. */
function ArchivedLine({ room }: { readonly room: Room }) {
  const { t } = usePresentation().i18n;
  const { unarchive } = useRoomActions();
  return (
    <View className="items-center gap-1 px-4 py-2">
      <Text className="text-center text-xs text-muted-foreground">
        {t("room.composerArchived", { name: room.name })}
      </Text>
      <PendingButton
        label={t("room.unarchive", { name: room.name })}
        onPress={() => unarchive(room)}
      />
    </View>
  );
}

/** A conversation whose bot or room was deleted. */
export function Gone({ onBack }: { readonly onBack: () => void }) {
  const { t } = usePresentation().i18n;
  return (
    <Centered>
      <StateMark icon={SearchX} />
      <Title>{t("empty.gone.title")}</Title>
      <Body>{t("empty.gone.body")}</Body>
      <Button label={t("empty.gone.back")} onPress={onBack} />
    </Centered>
  );
}

/**
 * A bot's conversation before anything is said in it. A first hello waiting
 * for its AI says so, with the same way to connect one as the first run.
 */
function Quiet({ bot, bottom }: { readonly bot: Bot; readonly bottom: number }) {
  const ctx = usePresentation();
  const status = useEngineStatus();
  const engine = status._tag === "ready" ? status.value : null;
  const name = bot.profile.name;
  const held = openingHeld(bot, engine);
  return (
    <View
      className="flex-1 items-center justify-center gap-4 px-6"
      style={{ paddingBottom: bottom }}
    >
      <Animated.View entering={popIn()}>
        <LiveBotAvatar bot={bot} size={96} />
      </Animated.View>
      <Title>{name}</Title>
      <Body>
        {held === null ? quietConversationText(bot, ctx) : heldHelloText(name, held, ctx)}
      </Body>
      {held !== null && held._tag !== "limit" && (
        <View className="w-full max-w-sm">
          <AiConnect engine={engine} />
        </View>
      )}
    </View>
  );
}

/**
 * A room before anything is said in it: its members, its name, and that every
 * one of them reads what is written there. An archived room takes nothing, so
 * it shows only who was in it.
 */
function QuietRoom({ room, bottom }: { readonly room: Room; readonly bottom: number }) {
  const { t } = usePresentation().i18n;
  const bots = useBots();
  return (
    <View
      className="flex-1 items-center justify-center gap-4 px-6"
      style={{ paddingBottom: bottom }}
    >
      <Animated.View entering={popIn()}>
        <RoomAvatar size={96} members={roomAvatarMembers(room, bots)} />
      </Animated.View>
      <Title>{room.name}</Title>
      {room.status === "active" && <Body>{t("empty.quiet.room")}</Body>}
    </View>
  );
}

/**
 * One row of the conversation: a time, a message, a card, a fold or a
 * notice, or a line for one of a kind this version does not know.
 */
function Row({
  row,
  room,
  turnBot,
  arriving,
  openingHold,
  onOpen,
  onOpenRoutine,
  onOpenBrowser,
  onOpenPair,
}: {
  readonly row: TimelineItem;
  /** In a room, the room, with its members now; null in a bot's conversation. */
  readonly room: Pick<Room, "id" | "members"> | null;
  /** In a bot's conversation, the bot: the row of its turn under way says what it is doing. */
  readonly turnBot: TurnBot | null;
  /** It just arrived at the end: it settles into place as it mounts. */
  readonly arriving: boolean;
  /** What holds the bot's hello back, which the operator's messages behind it wait for (`openingHeld`). */
  readonly openingHold: OpeningHold | null;
  readonly onOpen: (key: RosterItemKey) => void;
  readonly onOpenRoutine: (routineId: RoutineId) => void;
  readonly onOpenBrowser: (card: BrowserHelpEntry) => void;
  readonly onOpenPair: (pair: TeammateRunPair) => void;
}) {
  const ctx = usePresentation();
  const client = useJ3Client();
  // A message moves itself as it arrives; anything else settles in.
  const [settles] = useState(arriving);
  const entering = enteringWhen(settles, settleIn(springs.soft));
  switch (row.kind) {
    case "divider":
      return (
        <AnimatedView {...entering}>
          <Text className="py-2 text-center text-2xs text-muted-foreground">
            {dividerTime(row.at, ctx)}
          </Text>
        </AnimatedView>
      );
    case "message": {
      const { message } = row;
      return message._tag === "outgoing" ? (
        <OutgoingMessage row={row} message={message} room={room} arriving={arriving} />
      ) : (
        <ServerMessage
          row={row}
          message={message}
          room={room}
          arriving={arriving}
          openingHold={openingHold}
        />
      );
    }
    case "work":
      // A turn's row comes in on `pop` as the turn starts.
      return (
        <AnimatedView {...enteringWhen(settles, settleIn(springs.pop))}>
          <WorkFold fold={row.fold} live={row.live ? turnBot : null} />
          {row.fold !== null && row.fold.apps.length > 0 && (
            <View className="px-4">
              <ConnectorApps apps={row.fold.apps} />
            </View>
          )}
        </AnimatedView>
      );
    case "card": {
      const { entry } = row;
      return (
        <AnimatedView {...entering}>
          {entry._tag === "notice" ? (
            <NoticeLine
              entry={entry}
              onRetry={() => void client.retryNotice(entry.id)}
              onOpenConversation={() => {
                if (entry.notice._tag === "waiting-in-conversation") {
                  onOpen({ _tag: "bot", botId: entry.notice.botId });
                }
              }}
            />
          ) : (
            <Card entry={entry} onOpenBrowser={onOpenBrowser} />
          )}
        </AnimatedView>
      );
    }
    case "event":
      return (
        <AnimatedView {...entering}>
          <EventLine
            line={row.line}
            room={room?.id ?? null}
            onOpenRoutine={onOpenRoutine}
            onOpenPair={onOpenPair}
            onOpenRoom={(roomId) => onOpen({ _tag: "room", roomId })}
          />
        </AnimatedView>
      );
    case "unknown":
      return (
        <AnimatedView {...entering}>
          <NeedsUpdateLine />
        </AnimatedView>
      );
  }
}

type MessageRow = Extract<TimelineItem, { readonly kind: "message" }>;

/** In a room, the names a message highlights: only whom it addressed. */
function useHighlighted(room: Pick<Room, "members"> | null) {
  const bots = useBots();
  return (mentions: Mentions | null, labels: ReadonlyArray<MentionLabel>) =>
    room === null ? [] : mentionedNames(mentions, labels, (id) => bots.get(id)?.profile.name);
}

/**
 * A message this device sent, from Send to the server's entry. One that
 * failed for mentioning a member who left the room says so, and Send again
 * sends it without them.
 */
function OutgoingMessage({
  row,
  message,
  room,
  arriving,
}: {
  readonly row: MessageRow;
  readonly message: Extract<MessageRow["message"], { readonly _tag: "outgoing" }>;
  readonly room: Pick<Room, "members"> | null;
  readonly arriving: boolean;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const say = useSay();
  const bots = useBots();
  const highlighted = useHighlighted(room);
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name;
  const left =
    room === null || message.status._tag !== "not-sent"
      ? null
      : mentionedWhoLeft(message.status.failure, message.mentions, room.members);
  // A member who left is named as the operator picked it, which the message keeps.
  const labelOf = (botId: BotId) =>
    message.labels.find((label) => label.botId === botId)?.label ??
    nameOf(botId) ??
    t("bot.unknown");
  return (
    <MessageBubble
      message={message}
      position={row.position}
      arriving={arriving}
      mentionable={highlighted(message.mentions, message.labels)}
      onRetry={() =>
        void client.resend(message.commandId, left?.without).then((result) => {
          if (result._tag === "not-kept") say(t("message.changeNotKept"));
        })
      }
      onDiscard={() =>
        void client.discard(message.commandId).then((discarded) => {
          if (!discarded) say(t("message.changeNotKept"));
        })
      }
      {...(left === null || room === null
        ? {}
        : {
            leftRoom: left.left.map(labelOf),
            retryLabel: resendLabel(left.without, nameOf, ctx.i18n),
          })}
    />
  );
}

/** A message as the server keeps it. In a room, a bot's names who said it. */
function ServerMessage({
  row,
  message,
  room,
  arriving,
  openingHold,
}: {
  readonly row: MessageRow;
  readonly message: MessageEntry;
  readonly room: Pick<Room, "members"> | null;
  readonly arriving: boolean;
  readonly openingHold: OpeningHold | null;
}) {
  const client = useJ3Client();
  const bots = useBots();
  const highlighted = useHighlighted(room);
  const submitting = useSelected(
    client.actions,
    (actions) => actions.get(retryAction(message.id))?._tag === "submitting",
  );
  const { author } = message;
  const sender = author._tag === "bot" ? (bots.get(author.botId) ?? null) : null;
  return (
    <MessageBubble
      message={message}
      position={row.position}
      arriving={arriving}
      tint={sender?.profile.avatar ?? null}
      speaker={room !== null && author._tag === "bot" ? author.botId : null}
      // The server's entry keeps no names picked: its members go by their names now.
      mentionable={highlighted(message.mentions, [])}
      onRetry={() => void client.retryMessage(message.id)}
      submitting={submitting}
      openingHold={openingHold}
    />
  );
}
