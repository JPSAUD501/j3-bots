// SPDX-License-Identifier: AGPL-3.0-or-later
import { scheduleInWords } from "@j3-bots/client-runtime/wording";
import type { RoutineChangeEntry } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { CalendarClock, CirclePause, Trash2, Webhook } from "lucide-react-native";
import { use } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePresentation } from "../presentation.tsx";
import { EntryWidths } from "./widths.ts";

const changeText: Record<RoutineChangeEntry["change"], KeyWith> = {
  created: "routine.change.created",
  updated: "routine.change.updated",
  paused: "routine.change.paused",
  resumed: "routine.change.resumed",
  deleted: "routine.change.deleted",
};

/**
 * A routine was created or changed: the exact schedule it now has, in words.
 * It opens the bot's details, which list its routines; a deleted routine
 * has nowhere to go.
 */
export function RoutineChangeCard({
  entry,
  onOpen,
}: {
  readonly entry: RoutineChangeEntry;
  readonly onOpen: () => void;
}) {
  const ctx = usePresentation();
  const widths = use(EntryWidths);
  const deleted = entry.change === "deleted";
  const words = scheduleInWords(entry.trigger, ctx);
  const icon = deleted
    ? Trash2
    : entry.change === "paused"
      ? CirclePause
      : entry.trigger._tag === "webhook"
        ? Webhook
        : CalendarClock;
  return (
    <View className="mt-2 px-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: deleted }}
        disabled={deleted}
        onPress={onOpen}
        style={{ width: widths.compactCard }}
        className="min-h-11 flex-row items-center gap-3 self-start rounded-md border border-border bg-surface px-3 py-2.5"
      >
        <View className="size-8 items-center justify-center rounded-md bg-muted">
          <Icon icon={icon} color="accent-muted-foreground" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-2xs text-muted-foreground">
            {ctx.i18n.t(changeText[entry.change])}
          </Text>
          <Text numberOfLines={1} className="text-sm font-medium text-foreground">
            {entry.name}
          </Text>
          {!deleted && (
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {words ?? (entry.trigger._tag === "schedule" ? entry.trigger.cron : "")}
            </Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}
