// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MentionLabel, retryAction } from "@j3-bots/client-runtime";
import {
  addressed,
  addresseeOf,
  buildTimeline,
  mentionedNames,
  mentionedWhoLeft,
  roomStopFailed,
  rosterKeyOf,
  rosterTarget,
  type TimelineItem,
} from "@j3-bots/client-runtime/presentation";
import { useConversation, useDraft, useJ3Client, useSelected } from "@j3-bots/client-runtime/react";
import { addresseeLine, dividerTime, resendLabel } from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  BotId,
  EntryId,
  EntryOrder,
  EntryTarget,
  MessageEntry,
  Mentions,
  Room,
  RosterItem,
} from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type {
  LegendListRef,
  OnViewableItemsChangedInfo,
  ViewabilityConfigCallbackPairs,
} from "@legendapp/list/react-native";
import { useIsFocused } from "@react-navigation/native";
import { type ComponentRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/Avatar.tsx";
import { PendingButton } from "../components/form.tsx";
import { useRoomActions } from "../details/actions.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { useSay } from "../toast.tsx";
import { Body, Button, Centered, Title } from "../ui.tsx";
import { Card } from "./Card.tsx";
import { Composer, type MentionCandidate } from "./Composer.tsx";
import { ConversationHeader } from "./Header.tsx";
import { MessageBubble } from "./MessageBubble.tsx";
import { NoticeLine } from "./NoticeLine.tsx";
import { EntryWidths } from "./widths.ts";
import { WorkFold } from "./WorkFold.tsx";

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

/** The order of the entry a row shows; none for a divider or a message still on its way. */
const orderOf = (row: TimelineItem): EntryOrder | null => {
  switch (row.kind) {
    case "divider":
      return null;
    case "message":
      return row.message._tag === "message" ? row.message.order : null;
    case "card":
      return row.entry.order;
  }
};

/**
 * An entry counts as seen once half of it shows or, taller than the
 * conversation, once it covers half of the conversation's height, as on the
 * web.
 */
const SEEN_PERCENT = 50;

/**
 * Marks read the newest entry the operator can see, and tells the server the
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
      // A divider or a message still on its way has no order: the newest seen row with one counts.
      const newest = now.findLast(
        (row) => (half.has(row.key) || covering.has(row.key)) && orderOf(row) !== null,
      );
      const order = newest === undefined ? null : orderOf(newest);
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
 * A bot's or room's conversation: its header, every entry oldest first with
 * the newest at the bottom, and the composer, which rides on the keyboard.
 * Mount one per conversation, keyed by it.
 */
export function ConversationView({
  item,
  onBack,
  onOpenDetails,
  onOpenBot,
  onGone,
}: {
  readonly item: RosterItem;
  /** On a phone, back to the roster; beside the roster there is none. */
  readonly onBack: (() => void) | null;
  readonly onOpenDetails: () => void;
  /** Opens a bot's own conversation, as a notice in a room offers. */
  readonly onOpenBot: (botId: BotId) => void;
  /** Leaves a conversation whose bot or room was deleted. */
  readonly onGone: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const say = useSay();
  const bots = useBots();
  const insets = useSafeAreaInsets();
  // Mounted per conversation: the target stays the one it opened with.
  const [target] = useState(() => rosterTarget(rosterKeyOf(item)));
  const { state, loadOlder, markRead } = useConversation(target);
  const rows = useMemo(() => buildTimeline(state?.items ?? []), [state?.items]);
  const inView = useInView();
  const pairs = useReadMark(target, rows, markRead, inView);

  const list = useRef<LegendListRef>(null);
  const composer = useRef<ComponentRef<typeof View>>(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    list,
    composer,
  );
  const [composerHeight, setComposerHeight] = useState(0);
  const [column, setColumn] = useState(0);
  const widths = useMemo(() => {
    const { max, bubbleShare, cardShare } = layout.entryWidth;
    return {
      bubble: Math.min(max, column * bubbleShare),
      card: Math.min(max, column * cardShare),
      compactCard: Math.min(layout.compactCardWidth, column * cardShare),
      column,
    };
  }, [column]);

  const room = item._tag === "room" ? item.room : null;
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name;

  const draft = useDraft(target);
  // Who the message wakes as the draft stands: only mentions picked, and still standing, count.
  const addressing =
    room === null ? undefined : addressed(draft.text, draft.mentions, room.members);
  const addressee =
    room === null
      ? null
      : addresseeLine(
          addresseeOf(addressing?.mentions ?? null, room.hostId, nameOf, ctx.i18n),
          ctx.i18n,
        );
  const mentionable: ReadonlyArray<MentionCandidate> | undefined = room?.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, name: bot.profile.name, avatar: bot.profile.avatar }];
  });
  const send = () =>
    void client.sendDraft(target, addressing).then((result) => {
      if (result === "not-kept") say(t("composer.notKept"));
    });

  const stop = () => {
    if (item._tag === "bot") {
      void client.stopBot(item.bot.id);
      return;
    }
    const { name } = item.room;
    void client.stopRoom(item.room.id).then((result) => {
      if (roomStopFailed(result)) say(t("room.stopFailed", { name }));
    });
  };
  const goTo = (entryId: EntryId) => {
    const index = rows.findIndex((row) => row.kind === "card" && row.entry.id === entryId);
    if (index !== -1)
      void list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  };

  const archived = room !== null && room.status === "archived";
  const quiet = item._tag === "bot" && state?.phase === "ready" && state.items.length === 0;

  return (
    <View className="flex-1 bg-background">
      <View style={{ paddingTop: insets.top }}>
        <ConversationHeader
          item={item}
          onBack={onBack}
          onOpenDetails={onOpenDetails}
          onGoToWaiting={goTo}
          onStop={stop}
        />
      </View>
      {state?.phase === "not-found" ? (
        <Gone onBack={onGone} />
      ) : (
        <View
          className="flex-1"
          onLayout={(event) =>
            setColumn(Math.min(event.nativeEvent.layout.width, layout.textColumn))
          }
        >
          <EntryWidths value={widths}>
            {quiet ? (
              <Quiet bot={item.bot} bottom={composerHeight} />
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
                      onOpenBot={onOpenBot}
                      onOpenDetails={onOpenDetails}
                    />
                  </View>
                )}
                extraData={{ room, widths }}
                alignItemsAtEnd
                initialScrollAtEnd
                maintainScrollAtEnd
                maintainVisibleContentPosition
                onStartReached={() => {
                  if (state?.hasOlder === true && !state.loadingOlder) loadOlder();
                }}
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
                contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
              />
            )}
          </EntryWidths>
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
                    {...(addressee === null ? {} : { addressee })}
                    onSend={send}
                    inView={inView}
                  />
                )}
              </View>
            </View>
          </KeyboardStickyView>
        </View>
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
      <Title>{t("empty.gone.title")}</Title>
      <Body>{t("empty.gone.body")}</Body>
      <Button label={t("empty.gone.back")} onPress={onBack} />
    </Centered>
  );
}

/** A bot's conversation before anything is said in it. */
function Quiet({ bot, bottom }: { readonly bot: Bot; readonly bottom: number }) {
  const { t } = usePresentation().i18n;
  const name = bot.profile.name;
  const gettingReady = bot.state._tag === "thinking" || bot.state._tag === "working";
  return (
    <View
      className="flex-1 items-center justify-center gap-4 px-6"
      style={{ paddingBottom: bottom }}
    >
      <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={72} />
      <Title>{name}</Title>
      <Body>
        {gettingReady ? t("empty.quiet.speaksFirst", { name }) : t("empty.quiet.body", { name })}
      </Body>
    </View>
  );
}

/** One row of the conversation: a time, a message, a card, a fold or a notice. */
function Row({
  row,
  room,
  onOpenBot,
  onOpenDetails,
}: {
  readonly row: TimelineItem;
  /** In a room, its members and host now; null in a bot's conversation. */
  readonly room: Pick<Room, "members" | "hostId"> | null;
  readonly onOpenBot: (botId: BotId) => void;
  readonly onOpenDetails: () => void;
}) {
  const ctx = usePresentation();
  const client = useJ3Client();
  switch (row.kind) {
    case "divider":
      return (
        <Text className="py-3 text-center text-2xs text-muted-foreground">
          {dividerTime(row.at, ctx)}
        </Text>
      );
    case "message": {
      const { message } = row;
      return message._tag === "outgoing" ? (
        <OutgoingMessage row={row} message={message} room={room} />
      ) : (
        <ServerMessage row={row} message={message} room={room} />
      );
    }
    case "card": {
      const { entry } = row;
      switch (entry._tag) {
        case "work-fold":
          return <WorkFold entry={entry} />;
        case "notice":
          return (
            <NoticeLine
              entry={entry}
              onRetry={() => void client.retryNotice(entry.id)}
              onOpenConversation={() => {
                if (entry.notice._tag === "waiting-in-conversation") onOpenBot(entry.notice.botId);
              }}
            />
          );
        default:
          return <Card entry={entry} onOpenBot={onOpenBot} onOpenDetails={onOpenDetails} />;
      }
    }
  }
}

type MessageRow = Extract<TimelineItem, { readonly kind: "message" }>;

/** In a room, the names a message highlights: only whom it addressed. */
function useHighlighted(room: Pick<Room, "members" | "hostId"> | null) {
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
}: {
  readonly row: MessageRow;
  readonly message: Extract<MessageRow["message"], { readonly _tag: "outgoing" }>;
  readonly room: Pick<Room, "members" | "hostId"> | null;
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
            retryLabel: resendLabel(
              addresseeOf(left.without, room.hostId, nameOf, ctx.i18n),
              ctx.i18n,
            ),
          })}
    />
  );
}

/** A message as the server keeps it. In a room, a bot's names who said it. */
function ServerMessage({
  row,
  message,
  room,
}: {
  readonly row: MessageRow;
  readonly message: MessageEntry;
  readonly room: Pick<Room, "members" | "hostId"> | null;
}) {
  const client = useJ3Client();
  const bots = useBots();
  const highlighted = useHighlighted(room);
  const submitting = useSelected(
    client.actions,
    (actions) => actions.get(retryAction(message.id))?._tag === "submitting",
  );
  const { author } = message;
  return (
    <MessageBubble
      message={message}
      position={row.position}
      speaker={room !== null && author._tag === "bot" ? (bots.get(author.botId) ?? null) : null}
      // The server's entry keeps no names picked: its members go by their names now.
      mentionable={highlighted(message.mentions, [])}
      onRetry={() => void client.retryMessage(message.id)}
      submitting={submitting}
    />
  );
}
