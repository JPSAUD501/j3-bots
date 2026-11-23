// SPDX-License-Identifier: AGPL-3.0-or-later
import { useTurnAnnouncement } from "@j3-bots/client-runtime/react";
import { memberList, presenceLine, type StatusLine } from "@j3-bots/client-runtime/wording";
import type { EntryId, RosterItem, WorkFoldEntry } from "@j3-bots/contracts";
import { ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react-native";
import { useState } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { RoomAvatar, roomAvatarMembers } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar, useOffline } from "../components/avatar/mood.tsx";
import { Icon } from "../components/Icon.tsx";
import { toneClass } from "../components/RosterRow.tsx";
import { SwapText } from "../components/SwapText.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";

/**
 * Who this is, and one line saying what it is doing now. The block with the
 * name opens the details, where Stop is while there is work to stop. While the bot waits, "Waiting for you" at the end
 * brings the card it waits on into view. Each change of state and each new
 * line is announced once, as it happens, then how the turn ended
 * (`useTurnAnnouncement`). Mount one per conversation, so moving to another
 * announces nothing.
 */
const announce = (text: string) => AccessibilityInfo.announceForAccessibility(text);

export function ConversationHeader({
  item,
  onBack,
  onOpenDetails,
  onGoToWaiting,
  folds,
}: {
  readonly item: RosterItem;
  /** On a phone, back to the roster; beside the roster there is none. */
  readonly onBack: (() => void) | null;
  readonly onOpenDetails: () => void;
  readonly onGoToWaiting: (entryId: EntryId) => void;
  /** The conversation's work folds: when a turn ends, the line it folds into is said aloud. */
  readonly folds: ReadonlyArray<WorkFoldEntry>;
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

  // The block with the name turns muted while pressed: the avatar's light keeps its ring in that color.
  const [pressed, setPressed] = useState(false);
  const ground = pressed ? "muted" : "background";

  // Each change of state and each new line is said once, then how the turn ended; not the first.
  const offline = useOffline();
  useTurnAnnouncement(item._tag === "bot" ? item.bot : null, folds, offline, ctx, announce);

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
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2.5 rounded-md px-1.5 active:bg-muted"
      >
        {item._tag === "bot" ? (
          <LiveBotAvatar
            bot={item.bot}
            lastEntry={item.lastEntry}
            size={32}
            ground={ground}
            markPrimary
          />
        ) : (
          <RoomAvatar size={32} ground={ground} members={roomAvatarMembers(item.room, bots)} />
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
          {line === null ? (
            <Text
              numberOfLines={1}
              className="text-2xs"
              importantForAccessibility="no"
              accessibilityElementsHidden
            >
              {" "}
            </Text>
          ) : (
            <SwapText text={line.text} className={`text-2xs ${toneClass[line.tone]}`} />
          )}
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
    </View>
  );
}
