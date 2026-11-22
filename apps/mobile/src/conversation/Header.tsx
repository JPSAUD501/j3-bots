// SPDX-License-Identifier: AGPL-3.0-or-later
import { canStop, roomStop } from "@j3-bots/client-runtime/presentation";
import { memberList, presenceLine, type StatusLine } from "@j3-bots/client-runtime/wording";
import type { Bot, EntryId, RosterItem } from "@j3-bots/contracts";
import { ChevronLeft, ChevronRight, CornerDownRight, Square } from "lucide-react-native";
import { useEffect, useEffectEvent, useRef } from "react";
import { AccessibilityInfo, Alert, Pressable, Text, View } from "react-native";
import { BotAvatar, RoomAvatar } from "../components/Avatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { toneClass } from "../components/RosterRow.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";

/** What a bot is doing, as a transition between states: activity text changing within one does not count. */
const stateOf = (bot: Bot) =>
  bot.state._tag === "thinking" || bot.state._tag === "working"
    ? `${bot.state._tag}:${bot.state.stalled}`
    : bot.state._tag;

/**
 * Who this is, and one line saying what it is doing now. The block with the
 * name opens the details. While the bot waits, "Waiting for you" at the end
 * brings the card it waits on into view. A change of state is announced
 * once, as it happens. Mount one per conversation, so moving to another
 * announces nothing.
 */
export function ConversationHeader({
  item,
  onBack,
  onOpenDetails,
  onGoToWaiting,
  onStop,
}: {
  readonly item: RosterItem;
  /** On a phone, back to the roster; beside the roster there is none. */
  readonly onBack: (() => void) | null;
  readonly onOpenDetails: () => void;
  readonly onGoToWaiting: (entryId: EntryId) => void;
  /** A bot's Stop runs at once; a room's, once the operator confirms it. */
  readonly onStop: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const name = itemName(item);
  const line: StatusLine | null =
    item._tag === "bot"
      ? presenceLine(item.bot, ctx)
      : { text: t("room.members", { names: memberList(item.room, ctx) }), tone: "secondary" };
  const waitingOn =
    item._tag === "bot" && item.bot.state._tag === "waiting" ? item.bot.state.entryId : null;
  const botStop = item._tag === "bot" && canStop(item.bot);
  const roomStopping = item._tag === "room" ? roomStop(item.room) : "hidden";

  const state = item._tag === "bot" ? stateOf(item.bot) : null;
  const announced = useRef(state);
  const text = line?.text ?? "";
  const announce = useEffectEvent(() => AccessibilityInfo.announceForAccessibility(text));
  useEffect(() => {
    if (announced.current === state) return;
    announced.current = state;
    announce();
  }, [state]);

  const confirmRoomStop = () =>
    Alert.alert(t("room.stop.title", { name }), t("room.stop.body", { name }), [
      { text: t("room.stop.cancel"), style: "cancel" },
      { text: t("room.stop"), style: "destructive", onPress: onStop },
    ]);

  return (
    <View className="min-h-14 flex-row items-center gap-1 border-b border-border px-2">
      {onBack !== null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("conversation.back")}
          onPress={onBack}
          className="size-11 items-center justify-center"
        >
          <Icon icon={ChevronLeft} size={20} color="accent-foreground" />
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("conversation.openDetails", { name })}
        accessibilityHint={line?.text}
        onPress={onOpenDetails}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2.5 rounded-md px-1.5 active:bg-muted"
      >
        {item._tag === "bot" ? (
          <BotAvatar avatar={item.bot.profile.avatar} state={item.bot.state} size={28} />
        ) : (
          <RoomAvatar
            size={28}
            members={item.room.members.flatMap((id) => {
              const bot = bots.get(id);
              return bot === undefined ? [] : [bot.profile.avatar];
            })}
          />
        )}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-0.5">
            <Text numberOfLines={1} className="shrink text-base font-medium text-foreground">
              {name}
            </Text>
            <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
          </View>
          {/* The line keeps its place when it says nothing, so the name never moves as the bot's
              state changes. */}
          <Text
            numberOfLines={1}
            className={`text-2xs ${line === null ? "" : toneClass[line.tone]}`}
            importantForAccessibility={line === null ? "no" : "auto"}
            accessibilityElementsHidden={line === null}
          >
            {line?.text ?? " "}
          </Text>
        </View>
      </Pressable>
      {waitingOn !== null && (
        // The line under the name already says "Waiting for you": this is the whole target that
        // brings the card into view, apart from the name that opens the details.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("presence.waiting.goTo")}
          onPress={() => onGoToWaiting(waitingOn)}
          className="size-11 items-center justify-center"
        >
          <Icon icon={CornerDownRight} size={18} color="accent-waiting" />
        </Pressable>
      )}
      {(botStop || roomStopping !== "hidden") && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: roomStopping === "stopping" }}
          onPress={
            item._tag === "bot" ? onStop : roomStopping === "offered" ? confirmRoomStop : undefined
          }
          className="min-h-11 flex-row items-center gap-1.5 rounded-md border border-input px-3"
        >
          <Icon icon={Square} size={12} color="accent-foreground" filled />
          <Text className="text-sm text-foreground">
            {roomStopping === "stopping" ? t("conversation.stopping") : t("conversation.stop")}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
