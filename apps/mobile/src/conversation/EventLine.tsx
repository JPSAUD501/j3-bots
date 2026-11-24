// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EventLine as Line,
  eventLineOpens,
  type RoutineChanges,
} from "@j3-bots/client-runtime/presentation";
import {
  activityTime,
  type EventIcon,
  type EventLineWords,
  type EventMark,
  eventLineWords,
  handoffHeading,
  handoffMarks,
  routineChangeDetail,
} from "@j3-bots/client-runtime/wording";
import type { BotId, HandoffEntry, RoutineId } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import {
  CalendarClock,
  ChevronRight,
  CirclePause,
  type LucideIcon,
  MessagesSquare,
  Trash2,
  Webhook,
} from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { MessageText } from "./MessageText.tsx";

const icons: Record<EventIcon, LucideIcon> = {
  routine: CalendarClock,
  webhook: Webhook,
  paused: CirclePause,
  deleted: Trash2,
  message: MessagesSquare,
};

const markTone: Record<EventMark["tone"], string> = {
  waiting: "text-waiting",
  blocked: "text-blocked",
  quiet: "text-muted-foreground",
};

/**
 * The line's own height. Its touch target grows past it by `SLOP` on every
 * side, to the touch target's height. A view takes no touch beyond its own
 * box, so the slop sits inside a frame grown by as much, which its negative
 * margin keeps out of the layout; the row is padded by `SLOP` too, so the
 * target ends where the row does and never reaches into the next one, which
 * the list may stack over or under it.
 */
const LINE_HEIGHT = 24;
const SLOP = (layout.touchTarget - LINE_HEIGHT) / 2;
const slopFrame = { padding: SLOP, margin: -SLOP } as const;

/**
 * Something that happened, told in one quiet centred line about as tall as a
 * time between messages: a teammate's face or a glyph, then a short sentence
 * with the name in medium weight. A line with more to show opens it: a
 * teammate message in full, or the routines of a line that tells several, in
 * a sheet; a routine, over its bot's details. The rest only tell.
 */
export function EventLine({
  line,
  onOpenBot,
  onOpenRoutine,
}: {
  readonly line: Line;
  readonly onOpenBot: (botId: BotId) => void;
  readonly onOpenRoutine: (routineId: RoutineId) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [open, setOpen] = useState(false);
  const words = eventLineWords(line, ctx);
  const opens = eventLineOpens(line);
  const sentence = <Sentence words={words} />;
  const title = words.runs.map((run) => run.text).join("");
  return (
    <View className="items-center px-4" style={{ paddingVertical: SLOP }}>
      {opens === null ? (
        <View
          accessible
          accessibilityLabel={words.label}
          style={{ minHeight: LINE_HEIGHT }}
          className="max-w-full flex-row items-center justify-center gap-1.5"
        >
          {sentence}
        </View>
      ) : (
        <PressScale
          accessibilityRole="button"
          accessibilityLabel={words.label}
          accessibilityHint={
            opens._tag === "routine"
              ? t("eventLine.opensRoutine")
              : opens._tag === "message"
                ? t("eventLine.opensMessage")
                : t("eventLine.opensRoutines")
          }
          frame={slopFrame}
          hitSlop={SLOP}
          onPress={() => {
            if (opens._tag === "routine") onOpenRoutine(opens.routineId);
            else setOpen(true);
          }}
          style={{ minHeight: LINE_HEIGHT }}
          className="max-w-full flex-row items-center justify-center gap-1.5 rounded-md px-1.5 active:bg-muted"
        >
          {sentence}
        </PressScale>
      )}
      {opens?._tag === "message" && (
        <MessageSheet
          open={open}
          title={title}
          peer={opens.peer}
          entry={opens.entry}
          onClose={() => setOpen(false)}
          onOpenBot={(botId) => {
            setOpen(false);
            onOpenBot(botId);
          }}
        />
      )}
      {opens?._tag === "routines" && (
        <Sheet open={open} title={title} onClose={() => setOpen(false)}>
          <Routines
            changes={opens.changes}
            onOpenRoutine={(routineId) => {
              setOpen(false);
              onOpenRoutine(routineId);
            }}
          />
        </Sheet>
      )}
    </View>
  );
}

function Sentence({ words }: { readonly words: EventLineWords }) {
  return (
    <>
      {words.lead._tag === "bot" ? (
        <Face botId={words.lead.botId} size={16} />
      ) : (
        <Icon icon={icons[words.lead.icon]} size={14} color="accent-muted-foreground" />
      )}
      <Text className="shrink text-center text-2xs text-muted-foreground">
        {words.runs.map((run) =>
          run.strong ? (
            <Text key={run.at} className="font-medium">
              {run.text}
            </Text>
          ) : (
            run.text
          ),
        )}
        {words.status !== null && (
          <>
            {" · "}
            <Text className={`font-medium ${markTone[words.status.tone]}`}>
              {words.status.text}
            </Text>
          </>
        )}
      </Text>
    </>
  );
}

/** A teammate's face, still: the words name it, so its face says nothing more. */
function Face({ botId, size }: { readonly botId: BotId; readonly size: number }) {
  const bot = useBots().get(botId);
  return bot === undefined ? null : (
    <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={size} still />
  );
}

/**
 * A teammate message in full, headed by its direction, its marks and its
 * time, with a way to the teammate's own conversation while it has one.
 */
function MessageSheet({
  open,
  title,
  peer,
  entry,
  onClose,
  onOpenBot,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly peer: BotId;
  readonly entry: HandoffEntry;
  readonly onClose: () => void;
  readonly onOpenBot: (botId: BotId) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const other = useBots().get(peer);
  const name = other?.profile.name ?? t("eventLine.deletedBot");
  return (
    <Sheet
      open={open}
      title={title}
      lead={<Face botId={peer} size={24} />}
      onClose={onClose}
      footer={
        other !== undefined && (
          <View className="border-t border-border px-5 py-3">
            <Button
              variant="secondary"
              label={t("eventLine.openConversation", { name })}
              onPress={() => onOpenBot(peer)}
            />
          </View>
        )
      }
    >
      <View className="mb-2 flex-row flex-wrap items-baseline gap-x-2">
        <Text className="text-xs text-muted-foreground">
          {handoffHeading(entry, name, ctx.i18n)}
        </Text>
        {handoffMarks(entry, ctx.i18n).map((mark) => (
          <Text key={mark.text} className={`text-xs font-medium ${markTone[mark.tone]}`}>
            {mark.text}
          </Text>
        ))}
        <Text className="ms-auto text-xs text-muted-foreground">
          {activityTime(entry.createdAt, ctx)}
        </Text>
      </View>
      <MessageText text={entry.text} mentionable={[]} className="text-base text-foreground" />
    </Sheet>
  );
}

/** The routines of a line that tells several: each named over when it runs, and opened from here. */
function Routines({
  changes,
  onOpenRoutine,
}: {
  readonly changes: RoutineChanges;
  readonly onOpenRoutine: (routineId: RoutineId) => void;
}) {
  const ctx = usePresentation();
  return (
    <View className="-mx-2">
      {changes.map((change) => {
        const detail = routineChangeDetail(change, ctx);
        const rows = (
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-base font-medium text-foreground">
              {change.name}
            </Text>
            {detail !== null && (
              <Text numberOfLines={1} className="text-sm text-muted-foreground">
                {detail}
              </Text>
            )}
          </View>
        );
        return change.change === "deleted" ? (
          <View key={change.routineId} className="min-h-11 flex-row items-center px-2 py-2">
            {rows}
          </View>
        ) : (
          <PressScale
            key={change.routineId}
            depth="row"
            accessibilityRole="button"
            accessibilityHint={ctx.i18n.t("eventLine.opensRoutine")}
            onPress={() => onOpenRoutine(change.routineId)}
            className="min-h-11 flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted"
          >
            {rows}
            <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
          </PressScale>
        );
      })}
    </View>
  );
}
