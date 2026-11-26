// SPDX-License-Identifier: AGPL-3.0-or-later
import { noticeText } from "@j3-bots/client-runtime/wording";
import type { NoticeEntry } from "@j3-bots/contracts";
import {
  CircleAlert,
  CircleArrowUp,
  CirclePause,
  CornerDownRight,
  OctagonPause,
  UserRoundCheck,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePresentation } from "../presentation.tsx";

/**
 * A quiet line where something stopped, or where a bot changed something the
 * operator should know about, with Try again when the server still takes one.
 * A failed turn's technical words stay behind Details. It is part of the
 * conversation, not an announcement: the header says a change of state.
 */
export function NoticeLine({
  entry,
  onRetry,
  onOpenConversation,
}: {
  readonly entry: NoticeEntry;
  readonly onRetry: () => void;
  readonly onOpenConversation: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { notice } = entry;
  const details = notice._tag === "turn-failed" ? notice.details : undefined;
  const [showDetails, setShowDetails] = useState(false);
  const failed =
    notice._tag === "turn-failed" ||
    notice._tag === "handoff-failed" ||
    notice._tag === "undelivered";
  const waiting = notice._tag === "waiting-in-conversation";
  const tone = failed ? "blocked" : waiting ? "waiting" : "muted-foreground";
  const textTone = {
    blocked: "text-blocked",
    waiting: "text-waiting",
    "muted-foreground": "text-muted-foreground",
  }[tone];
  const iconTone = {
    blocked: "accent-blocked",
    waiting: "accent-waiting",
    "muted-foreground": "accent-muted-foreground",
  }[tone];
  const icon =
    notice._tag === "chain-stopped"
      ? OctagonPause
      : waiting
        ? CirclePause
        : notice._tag === "operator-named"
          ? UserRoundCheck
          : CircleAlert;
  return (
    <View className="my-1 items-center px-4">
      <View className="flex-row flex-wrap items-center justify-center gap-x-2">
        <Icon icon={icon} size={14} color={iconTone} />
        <Text className={`text-center text-xs ${textTone}`}>{noticeText(notice, ctx)}</Text>
        {entry.retryable && (
          <Pressable
            accessibilityRole="button"
            onPress={onRetry}
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-xs text-accent">{t("notice.retry")}</Text>
          </Pressable>
        )}
        {waiting && (
          <Pressable
            accessibilityRole="button"
            onPress={onOpenConversation}
            className="min-h-11 flex-row items-center gap-1 px-2"
          >
            <Icon icon={CornerDownRight} size={14} color="accent-accent" />
            <Text className="text-xs text-accent">{t("notice.openConversation")}</Text>
          </Pressable>
        )}
        {details !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetails }}
            onPress={() => setShowDetails((shown) => !shown)}
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-xs text-muted-foreground">{t("failure.details")}</Text>
          </Pressable>
        )}
      </View>
      {details !== undefined && showDetails && (
        <Text
          selectable
          className="w-full rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
        >
          {details}
        </Text>
      )}
    </View>
  );
}

/** In place of an entry, or a notice, of a kind added after this version of the app. */
export function NeedsUpdateLine() {
  const { t } = usePresentation().i18n;
  return (
    <View className="my-1 flex-row flex-wrap items-center justify-center gap-x-2 px-4">
      <Icon icon={CircleArrowUp} size={14} color="accent-muted-foreground" />
      <Text className="text-center text-xs text-muted-foreground">{t("entry.needsUpdate")}</Text>
    </View>
  );
}
