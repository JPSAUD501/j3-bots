// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EventLine as Line,
  type EventLineOpens,
  eventLineOpens,
  type RoutineChanges,
  type TeammateRun,
  type TeammateRunPair,
} from "@j3-bots/client-runtime/presentation";
import {
  type EventIcon,
  type EventLineWords,
  eventLineWords,
  routineChangeDetail,
  teammateChoice,
} from "@j3-bots/client-runtime/wording";
import type { BotId, RoutineId } from "@j3-bots/contracts";
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
import { markTone } from "./markTone.ts";

const icons: Record<EventIcon, LucideIcon> = {
  routine: CalendarClock,
  webhook: Webhook,
  paused: CirclePause,
  deleted: Trash2,
  message: MessagesSquare,
};

/**
 * Something that happened, told in one quiet centred line about as tall as a
 * time between messages: a teammate's face or a glyph, then a short sentence
 * with the name in medium weight. A line with more to show opens it: a run of
 * teammate messages, their conversation at the run's first message, or, with
 * several teammates, a sheet to pick which; the routines of a line that tells
 * several, in a sheet; a routine, over its bot's details. The rest only tell.
 * A line that opens is pressed anywhere across its row, edge to edge: a row
 * that wide is easy to hit at 32 dp, and its target never reaches into the
 * next row.
 */
export function EventLine({
  line,
  onOpenRoutine,
  onOpenPair,
}: {
  readonly line: Line;
  readonly onOpenRoutine: (routineId: RoutineId) => void;
  /** Opens a teammate conversation at the run's first message with that teammate. */
  readonly onOpenPair: (pair: TeammateRunPair) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [open, setOpen] = useState(false);
  const words = eventLineWords(line, ctx);
  const opens = eventLineOpens(line);
  const sentence = <Sentence words={words} />;
  const title = words.runs.map((run) => run.text).join("");
  return (
    <View>
      {opens === null ? (
        <View
          accessible
          accessibilityLabel={words.label}
          className="min-h-8 flex-row items-center justify-center gap-1.5 px-4"
        >
          {sentence}
        </View>
      ) : (
        <PressScale
          accessibilityRole="button"
          accessibilityLabel={words.label}
          accessibilityHint={t(hints[opens._tag])}
          depth="row"
          onPress={() => {
            if (opens._tag === "routine") onOpenRoutine(opens.routineId);
            else if (opens._tag === "pair") onOpenPair(opens.pair);
            else setOpen(true);
          }}
          className="min-h-8 flex-row items-center justify-center gap-1.5 px-4 active:bg-muted"
        >
          {sentence}
        </PressScale>
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
      {opens?._tag === "pairs" && (
        <Sheet open={open} title={t("pairs.chooser")} onClose={() => setOpen(false)}>
          <Teammates
            pairs={opens.pairs}
            onOpenPair={(pair) => {
              setOpen(false);
              onOpenPair(pair);
            }}
          />
        </Sheet>
      )}
    </View>
  );
}

const hints = {
  pair: "eventLine.opensPair",
  pairs: "eventLine.opensPairs",
  routine: "eventLine.opensRoutine",
  routines: "eventLine.opensRoutines",
} as const satisfies Record<NonNullable<EventLineOpens>["_tag"], string>;

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
 * The teammates of a run with several, each its face and name over how many
 * messages, opening their conversation; a deleted teammate keeps a blank in
 * its face's place, so the names stay in line.
 */
function Teammates({
  pairs,
  onOpenPair,
}: {
  readonly pairs: TeammateRun["pairs"];
  readonly onOpenPair: (pair: TeammateRunPair) => void;
}) {
  const ctx = usePresentation();
  const bots = useBots();
  return (
    <View className="-mx-2">
      {pairs.map((pair) => {
        const choice = teammateChoice(pair, ctx);
        return (
          <PressScale
            key={pair.peer}
            depth="row"
            accessibilityRole="button"
            accessibilityLabel={`${choice.name}, ${choice.detail}`}
            accessibilityHint={ctx.i18n.t("eventLine.opensPair")}
            onPress={() => onOpenPair(pair)}
            className="min-h-11 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted"
          >
            {bots.has(pair.peer) ? (
              <Face botId={pair.peer} size={28} />
            ) : (
              <View className="size-7 rounded-pill bg-muted" />
            )}
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-base font-medium text-foreground">
                {choice.name}
              </Text>
              <Text numberOfLines={1} className="text-sm text-muted-foreground">
                {choice.detail}
              </Text>
            </View>
            <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
          </PressScale>
        );
      })}
    </View>
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
