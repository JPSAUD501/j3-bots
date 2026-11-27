// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildPairTimeline,
  type GroupPosition,
  pairMessageKey,
  type PairTimelineItem,
} from "@j3-bots/client-runtime/presentation";
import { usePair } from "@j3-bots/client-runtime/react";
import { dividerTime, handoffMarks, pairOrder } from "@j3-bots/client-runtime/wording";
import type { EntryId, PairBotIds, PairSeq, TeammateMessage } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarStack } from "../components/avatar/BotAvatar.tsx";
import { openIn } from "../motion.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Body, Centered } from "../ui.tsx";
import { AnimatedView } from "./animated.ts";
import { markTone } from "./markTone.ts";
import { MessageText } from "./MessageText.tsx";
import { ReadOnlyMark } from "./ReadOnlyMark.tsx";
import { Speaker, speakerGutter } from "./Speaker.tsx";
import { useTint } from "./tint.ts";

// The bottom corner by the face tightens, pointing at who spoke, and so does the top corner
// where a bubble meets the one above it in a group, as a bot's bubble does in a room.
const corners = {
  single: "rounded-bl-sm",
  first: "rounded-bl-sm",
  middle: "rounded-l-sm",
  last: "rounded-l-sm",
} as const satisfies Record<GroupPosition, string>;

/**
 * A teammate conversation's messages, oldest first with the newest at the
 * bottom, laid out the way a room lays out its bots' messages: a time between
 * quiet stretches, each bot's name over the first bubble of its group and its
 * face beside the last. Opened `at` a card of a bot's conversation, it reads
 * back to that message and shows it near the top. Where a composer would be,
 * a pill says no one writes here but the two bots.
 */
export function PairView({
  botIds,
  at,
}: {
  readonly botIds: PairBotIds;
  /** A teammate card in one of the two bots' conversations, whose message to open at. */
  readonly at: EntryId | undefined;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const insets = useSafeAreaInsets();
  const { state, loadOlder, reveal } = usePair(botIds);
  const rows = useMemo(() => buildPairTimeline(state?.messages ?? []), [state?.messages]);
  const list = useRef<LegendListRef>(null);
  const [column, setColumn] = useState(0);
  const [footer, setFooter] = useState(0);
  const ready = state?.phase === "ready";
  const bots = useBots();
  // Both bots, in the order the title names them, over an empty conversation.
  const faces = pairOrder(botIds, ctx).flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
  });

  // The message to open at, once the conversation holds it; it is shown once.
  const [found, setFound] = useState<PairSeq | null>(null);
  useEffect(() => {
    if (at === undefined || !ready) return;
    let live = true;
    void reveal(at).then((seq) => {
      if (live) setFound(seq);
    });
    return () => {
      live = false;
    };
  }, [at, ready, reveal]);
  const shown = useRef(false);
  useEffect(() => {
    if (found === null || shown.current) return;
    const index = rows.findIndex((row) => row.key === pairMessageKey(found));
    if (index === -1) return;
    shown.current = true;
    // The time over it, when it has one, shows with it.
    const from = rows[index - 1]?.kind === "divider" ? index - 1 : index;
    void list.current?.scrollToIndex({ index: from, viewPosition: 0, animated: false });
  }, [found, rows]);

  const bubbleWidth = Math.min(layout.entryWidth.max, column * layout.entryWidth.bubbleShare);
  return (
    <AnimatedView
      entering={openIn()}
      className="flex-1"
      onLayout={(event) => setColumn(Math.min(event.nativeEvent.layout.width, layout.textColumn))}
    >
      {ready && rows.length === 0 ? (
        <View className="flex-1" style={{ paddingBottom: footer }}>
          <Centered>
            <AvatarStack members={faces} size={96} />
            <Body>{t("pairs.empty")}</Body>
          </Centered>
        </View>
      ) : (
        <LegendList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          estimatedItemSize={64}
          renderItem={({ item: row }) => (
            <View className="w-full self-center" style={{ maxWidth: layout.textColumn }}>
              <PairRow row={row} bubbleWidth={bubbleWidth} />
            </View>
          )}
          extraData={bubbleWidth}
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
          contentContainerStyle={{ paddingTop: 4, paddingBottom: footer + 8 }}
        />
      )}
      <View
        onLayout={(event) => setFooter(event.nativeEvent.layout.height)}
        pointerEvents="none"
        className="absolute start-0 end-0 bottom-0 items-center pt-2"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <ReadOnlyMark
          label={t("pairs.readOnly")}
          spoken={`${t("pairs.readOnly")}. ${t("pairs.readOnlyHint")}`}
        />
      </View>
    </AnimatedView>
  );
}

function PairRow({
  row,
  bubbleWidth,
}: {
  readonly row: PairTimelineItem;
  readonly bubbleWidth: number;
}) {
  const ctx = usePresentation();
  switch (row.kind) {
    case "divider":
      return (
        <Text className="py-2 text-center text-2xs text-muted-foreground">
          {dividerTime(row.at, ctx)}
        </Text>
      );
    case "message":
      return (
        <PairMessage message={row.message} position={row.position} bubbleWidth={bubbleWidth} />
      );
  }
}

/**
 * One teammate message: the bot's name over the first bubble of its group,
 * its face beside the last, the bubble in its color, and under it whether it
 * was urgent or never reached the teammate. A screen reader hears it as one
 * sentence: who, what, and its marks.
 */
function PairMessage({
  message,
  position,
  bubbleWidth,
}: {
  readonly message: TeammateMessage;
  readonly position: GroupPosition;
  readonly bubbleWidth: number;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const sender = useBots().get(message.from);
  const name = sender?.profile.name ?? t("bot.unknown");
  const bubble = useTint(sender?.profile.avatar ?? null).bubble;
  const marks = handoffMarks(message, ctx.i18n);
  return (
    <View
      accessible
      accessibilityLabel={[name, message.text, ...marks.map((mark) => mark.text)].join(". ")}
      className={`px-4 ${position === "single" || position === "first" ? "mt-2" : "mt-0.5"}`}
    >
      <Speaker botId={message.from} position={position}>
        <View
          style={{ maxWidth: Math.max(0, bubbleWidth - speakerGutter), backgroundColor: bubble }}
          className={`rounded-bubble px-3.5 py-2 ${corners[position]}`}
        >
          <MessageText
            text={message.text}
            mentionable={[]}
            className="text-bubble-bot-foreground"
          />
        </View>
      </Speaker>
      {marks.length > 0 && (
        <Text className="pt-0.5 text-2xs" style={{ paddingStart: speakerGutter }}>
          {marks.map((mark, index) => (
            <Text key={mark.text} className={`font-medium ${markTone[mark.tone]}`}>
              {index > 0 && <Text className="font-normal text-muted-foreground"> · </Text>}
              {mark.text}
            </Text>
          ))}
        </Text>
      )}
    </View>
  );
}
