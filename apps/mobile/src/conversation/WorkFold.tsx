// SPDX-License-Identifier: AGPL-3.0-or-later
import { shownPlan } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useWorkSteps } from "@j3-bots/client-runtime/react";
import {
  fillDetail,
  fillText,
  stepDetail,
  stepText,
  turnLine,
  workFoldTitle,
} from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  CredentialFill,
  EntryPreview,
  WorkFoldEntry,
  WorkImageId,
  WorkStep,
} from "@j3-bots/contracts";
import {
  Bot as BotIcon,
  Check,
  ChevronRight,
  Ellipsis,
  FileText,
  Globe,
  ImageOff,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react-native";
import { reanimatedSpring, resolveAvatar, springs } from "@j3-bots/design-tokens";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Text } from "../text.tsx";
import type { AvatarHandle } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar, useOffline } from "../components/avatar/mood.tsx";
import { Icon } from "../components/Icon.tsx";
import { toneClass } from "../components/RosterRow.tsx";
import { SwapText } from "../components/SwapText.tsx";
import { enteringWhen, settleIn, useReducedMotion, useStep } from "../motion.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { useImage } from "../platform/images.ts";
import { AnimatedView } from "./animated.ts";
import { useFileOpener } from "./FileOpener.tsx";
import { LittleOnes } from "./LittleOnes.tsx";
import { PlanCard, PlanLine } from "./PlanCard.tsx";

const stepIcon = {
  command: Terminal,
  edit: Pencil,
  read: FileText,
  search: Search,
  web: Globe,
  tool: Wrench,
  delegation: BotIcon,
  other: Ellipsis,
} as const satisfies Record<WorkStep["kind"], LucideIcon>;

/** The bot of a turn under way, as its row shows it. */
export interface TurnBot {
  readonly bot: Bot;
  /** The bot's latest entry, so its avatar speaks while a message of its own arrives. */
  readonly lastEntry: EntryPreview | null;
}

/**
 * A turn's work in one row. While the turn runs: a small copy of the bot and
 * one line saying, in plain words, what it is doing now; under it, the bot's
 * little ones while part of the work runs in parallel, and the turn's plan as
 * a short card. When it ends, the row folds into one quiet line, "Worked · 6
 * steps", that opens to every step, as the running row does once there are
 * steps, and the plan into a line of its own, "Plan done, 4 of 4". Never opens
 * by itself; its steps are read only while it is open.
 */
export function WorkFold({
  fold,
  live,
}: {
  /** The turn's fold; null for a turn under way that has done no work yet. */
  readonly fold: WorkFoldEntry | null;
  /** While the turn runs, its bot: the row says what it is doing, and for how long. */
  readonly live: TurnBot | null;
}) {
  const [open, setOpen] = useState(false);
  // The row folds into its line once the turn it showed ends; one that was over when it mounted is just there.
  const [wasLive, setWasLive] = useState(live !== null);
  if (live !== null && !wasLive) setWasLive(true);
  const folding = live === null && wasLive;
  const toggle = () => setOpen((was) => !was);
  // The turn's plan and little ones, and the bot whose they are: the one at work, or the fold's author.
  const face = useRef<AvatarHandle>(null);
  const bots = useBots();
  const author =
    live?.bot ?? (fold?.author._tag === "bot" ? bots.get(fold.author.botId) : undefined);
  const work = fold?.work ?? null;
  const plan = shownPlan(work);
  return (
    <View className="mt-2 px-4">
      {live !== null ? (
        <LiveLine
          turn={live}
          hasSteps={fold !== null && fold.stepCount > 0}
          open={open}
          onToggle={toggle}
          face={face}
        />
      ) : fold !== null ? (
        <AnimatedView {...enteringWhen(folding, settleIn(springs.pop))}>
          {fold.stepCount > 0 ? (
            <FoldLine fold={fold} open={open} onToggle={toggle} />
          ) : (
            <EndLine fold={fold} />
          )}
        </AnimatedView>
      ) : null}
      {/* For a turn seen running, and through its end, so the block it took closes instead of jumping shut. */}
      {author !== undefined && wasLive && (
        <LittleOnes
          littleOnes={work?.littleOnes ?? null}
          live={live !== null}
          avatar={author.profile.avatar}
          face={face}
        />
      )}
      {live !== null && plan !== null && (
        <PlanCard plan={plan} tint={resolveAvatar(live.bot.profile.avatar).color} />
      )}
      {open && fold !== null && fold.stepCount > 0 && (
        <AnimatedView entering={opening} exiting={closing}>
          <Steps foldId={fold.id} working={fold.status._tag === "running"} />
        </AnimatedView>
      )}
      {live === null && plan !== null && <PlanLine plan={plan} folding={folding} />}
    </View>
  );
}

/** A chevron that turns a quarter on `pop` as what it opens opens. */
function useChevron(open: boolean) {
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.set(withSpring(open ? 1 : 0, reanimatedSpring(springs.pop)));
  }, [open, turn]);
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
}

const failedOf = (fold: WorkFoldEntry) =>
  fold.status._tag === "finished" && fold.status.ending === "failed";

/** A turn stopped or failed before its first step: how it ended, with nothing to open. */
function EndLine({ fold }: { readonly fold: WorkFoldEntry }) {
  const ctx = usePresentation();
  return (
    <View className="min-h-11 justify-center">
      <Text className={`text-xs ${failedOf(fold) ? "text-blocked" : "text-muted-foreground"}`}>
        {workFoldTitle(fold, ctx)}
      </Text>
    </View>
  );
}

/** The folded line: how the turn ended, and how many steps. */
function FoldLine({
  fold,
  open,
  onToggle,
}: {
  readonly fold: WorkFoldEntry;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const ctx = usePresentation();
  const { plural } = ctx.i18n;
  const { status } = fold;
  const failed = failedOf(fold);
  const title = workFoldTitle(fold, ctx);
  const count = plural("work.steps", fold.stepCount);
  const chevron = useChevron(open);
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${title}, ${count}`}
      onPress={onToggle}
      frame={{ alignSelf: "flex-start", marginStart: -8 }}
      className="min-h-11 flex-row items-center gap-1.5 rounded-md px-2"
    >
      <AnimatedView style={chevron}>
        <Icon
          icon={ChevronRight}
          size={14}
          color={failed ? "accent-blocked" : "accent-muted-foreground"}
        />
      </AnimatedView>
      {/* A fold whose turn this client no longer sees running carries the quiet live mark. */}
      {status._tag === "running" && <LiveMark />}
      <Text className={`text-xs ${failed ? "text-blocked" : "text-muted-foreground"}`}>
        {title}
      </Text>
      <Text className="text-xs text-muted-foreground">· {count}</Text>
    </PressScale>
  );
}

/**
 * The running row: the bot at list size in its state and what it is doing
 * now, in plain words, swapping as it moves to a new step. Once there are
 * steps, a chevron opens them. The header says each new line aloud.
 */
function LiveLine({
  turn,
  hasSteps,
  open,
  onToggle,
  face,
}: {
  readonly turn: TurnBot;
  readonly hasSteps: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The bot's face, for its little ones to make it answer. */
  readonly face: RefObject<AvatarHandle | null>;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const offline = useOffline();
  const line = turnLine(turn.bot, offline, ctx);
  const chevron = useChevron(open);
  return (
    // Drawn over its little ones, which come out from behind the bot's face.
    <View style={styles.above} className="min-h-11 flex-row items-center gap-2.5">
      <View
        accessible
        accessibilityLabel={line.text}
        className="min-w-0 flex-1 flex-row items-center gap-2.5"
      >
        <LiveBotAvatar bot={turn.bot} lastEntry={turn.lastEntry} size={24} ref={face} />
        <View className="min-w-0 flex-1">
          <SwapText text={line.text} className={`text-xs ${toneClass[line.tone]}`} />
        </View>
      </View>
      {hasSteps && (
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("work.showSteps")}
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          className="size-11 items-center justify-center rounded-pill"
        >
          <AnimatedView style={chevron}>
            <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
          </AnimatedView>
        </PressScale>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  above: { zIndex: 1 },
});

/** The steps fade in as the fold opens and out as it closes; at once under reduced motion. */
const opening = FadeIn.duration(180);
const closing = FadeOut.duration(140);

/**
 * The fold's steps. `working`: its turn has not ended. A step still running
 * once it has, work the turn handed off, shows no mark: it reads as part of
 * the finished turn.
 */
function Steps({
  foldId,
  working,
}: {
  readonly foldId: WorkFoldEntry["id"];
  readonly working: boolean;
}) {
  const { i18n } = usePresentation();
  const { t } = i18n;
  const state = useWorkSteps(foldId);
  if (state === null || state.phase === "loading") {
    return <Text className="py-2 ps-5 text-xs text-muted-foreground">{t("work.loading")}</Text>;
  }
  return (
    <View className="ms-1.5 border-s border-border ps-3">
      {state.steps.map((step) => (
        <View key={step.id} className="min-h-7 flex-row items-start gap-2 py-1">
          <View className="mt-px">
            <Icon icon={stepIcon[step.kind]} size={14} color="accent-muted-foreground" />
          </View>
          {step.fill !== undefined ? (
            <FillLine fill={step.fill} />
          ) : (
            <View className="flex-1 items-start gap-1">
              <Text selectable className="text-xs text-foreground">
                {stepText(step, working, i18n)}
              </Text>
              <StepDetail step={step} />
              {step.image !== undefined && <StepImage id={step.image.id} />}
            </View>
          )}
          <StepStatus step={step} working={working} />
        </View>
      ))}
    </View>
  );
}

/**
 * What a step worked on, as it was given, under its plain words: the command,
 * the path or the search, quiet and in monospace, for whoever opened the
 * steps to see it. Long ones wrap, so each reads in full.
 */
function StepDetail({ step }: { readonly step: WorkStep }) {
  const detail = stepDetail(step);
  if (detail === null) return null;
  return (
    <Text selectable face="mono" className="text-2xs text-muted-foreground">
      {detail}
    </Text>
  );
}

/**
 * The image a step looked at, small, in a frame of fixed size, so the list
 * never moves as it arrives; pressing it shows it large. One that cannot be
 * had any more says so in place of it.
 */
function StepImage({ id }: { readonly id: WorkImageId }) {
  const { t } = usePresentation().i18n;
  const client = useJ3Client();
  const opener = useFileOpener();
  const image = useImage(client, { _tag: "work", id });
  // A file that stopped decoding as an image since the server checked it is as gone.
  const [undrawable, setUndrawable] = useState(false);
  const frame = "size-16 overflow-hidden rounded-md border border-border bg-muted";
  if (image._tag === "failed" || undrawable) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t("work.image.unavailable")}
        className={`${frame} items-center justify-center`}
      >
        <Icon icon={ImageOff} size={16} color="accent-muted-foreground" />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("work.image.open")}
      onPress={() => opener.openWorkImage(id)}
      className={frame}
    >
      {image._tag === "shown" && (
        <Image
          source={{ uri: image.uri }}
          resizeMode="cover"
          onError={() => setUndrawable(true)}
          style={{ flex: 1 }}
        />
      )}
    </Pressable>
  );
}

/**
 * A login's fill: which login and field, then where it was filled, or why it
 * was not, in the blocked tone, with the page's origin as the server checked it.
 */
function FillLine({ fill }: { readonly fill: CredentialFill }) {
  const { i18n } = usePresentation();
  const detail = fillDetail(fill, i18n);
  return (
    <View className="flex-1">
      <Text selectable className="text-xs text-foreground">
        {fillText(fill, i18n)}
      </Text>
      {detail !== "" && (
        <Text
          selectable
          className={`text-xs ${fill.outcome._tag === "filled" ? "text-muted-foreground" : "text-blocked"}`}
        >
          {detail}
        </Text>
      )}
    </View>
  );
}

function StepStatus({ step, working }: { readonly step: WorkStep; readonly working: boolean }) {
  const { t } = usePresentation().i18n;
  switch (step.status) {
    case "running":
      if (!working) return null;
      return (
        <View className="flex-row items-center gap-1.5">
          <LiveMark />
          <Text className="text-2xs text-muted-foreground">{t("work.stepRunning")}</Text>
        </View>
      );
    case "failed":
      return (
        <View accessible accessibilityLabel={t("work.stepFailed")}>
          <Icon icon={X} size={14} color="accent-blocked" />
        </View>
      );
    case "completed":
      return (
        <View accessible accessibilityLabel={t("work.stepDone")}>
          <Icon icon={Check} size={14} color="accent-muted-foreground" />
        </View>
      );
  }
}

/**
 * A small dot that breathes while something runs, stepped: 8 changes in
 * 1.4 s, so it never repaints every frame; still under reduced motion.
 */
function LiveMark() {
  const reduced = useReducedMotion();
  const step = useStep(1400, 8, !reduced);
  // 0 at rest, 1 at the breath's deepest, halfway through.
  const depth = 1 - Math.abs(step - 4) / 4;
  return (
    <View
      style={{ opacity: 1 - 0.65 * depth, transform: [{ scale: 1 - 0.3 * depth }] }}
      className="size-1.5 rounded-pill bg-foreground/70"
    />
  );
}
