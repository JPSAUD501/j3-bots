// SPDX-License-Identifier: AGPL-3.0-or-later
import { useTurnAnnouncement } from "@j3-bots/client-runtime/react";
import { memberList } from "@j3-bots/client-runtime/wording";
import type { RosterItem, WorkFoldEntry } from "@j3-bots/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { AvatarStack, roomAvatarMembers } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar, useOffline } from "../components/avatar/mood.tsx";
import { Icon } from "../components/Icon.tsx";
import { useLandingSpot } from "../onboarding/handoff.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";

/**
 * Who this is: a bot's face, its name and, under it, its title, or a room's
 * members side by side, up to three and then how many more, its name and,
 * under it, who is in it. What a bot is doing is the conversation's to show, in the turn under
 * way and its cards; the header only says it to screen readers, once at each
 * change of state and each new line, then how the turn ended
 * (`useTurnAnnouncement`). The block with the name opens the details, where
 * Stop is while there is work to stop. Mount one per conversation, so moving
 * to another announces nothing.
 */
const announce = (text: string) => AccessibilityInfo.announceForAccessibility(text);

export function ConversationHeader({
  item,
  onBack,
  onOpenDetails,
  folds,
}: {
  readonly item: RosterItem;
  /** On a phone, back to the roster; beside the roster there is none. */
  readonly onBack: (() => void) | null;
  readonly onOpenDetails: () => void;
  /** The conversation's work folds: when a turn ends, the line it folds into is said aloud. */
  readonly folds: ReadonlyArray<WorkFoldEntry>;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const name = itemName(item);
  // Under the name: who is in a room, or what a bot is for; a bot from before titles has none.
  const under =
    item._tag === "room"
      ? t("room.members", { names: memberList(item.room, ctx) })
      : item.bot.profile.title === ""
        ? null
        : item.bot.profile.title;

  // The block with the name turns muted while pressed: the avatar's light keeps its ring in that color.
  const [pressed, setPressed] = useState(false);
  const ground = pressed ? "muted" : "background";

  // Each change of state and each new line is said once, then how the turn ended; not the first.
  const offline = useOffline();
  // A first bot arriving from the first run lands here.
  const landing = useLandingSpot(item._tag === "bot" ? item.bot.id : null);
  useTurnAnnouncement(item._tag === "bot" ? item.bot : null, folds, offline, ctx, announce);

  // The block with the name keeps 4 px above and below its lines, so a
  // second line clears the border at the largest font sizes, where the header grows.
  return (
    <View className="min-h-12 flex-row items-center gap-1 border-b border-border px-2">
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
        {...(under === null ? {} : { accessibilityHint: under })}
        onPress={onOpenDetails}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-1.5 py-1 active:bg-muted"
      >
        {item._tag === "bot" ? (
          <View onLayout={landing.onLayout} style={{ opacity: landing.hidden ? 0 : 1 }}>
            <LiveBotAvatar
              bot={item.bot}
              lastEntry={item.lastEntry}
              size={28}
              ground={ground}
              markPrimary
            />
          </View>
        ) : (
          <AvatarStack size={28} ground={ground} members={roomAvatarMembers(item.room, bots)} />
        )}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-0.5">
            <Text numberOfLines={1} className="shrink text-base font-medium text-foreground">
              {name}
            </Text>
            <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
          </View>
          {under !== null && (
            <Text numberOfLines={1} className="text-2xs text-muted-foreground">
              {under}
            </Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}
