// SPDX-License-Identifier: AGPL-3.0-or-later
import { millisBetween, shortDuration } from "@j3-bots/client-runtime/presentation";
import { useWorkSteps } from "@j3-bots/client-runtime/react";
import { stepText, workFoldTitle } from "@j3-bots/client-runtime/wording";
import type { WorkFoldEntry, WorkStep } from "@j3-bots/contracts";
import {
  Bot,
  Check,
  ChevronRight,
  Ellipsis,
  FileText,
  Globe,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react-native";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useReducedMotion, useStep } from "../motion.ts";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { AnimatedView } from "./animated.ts";

const stepIcon = {
  command: Terminal,
  edit: Pencil,
  read: FileText,
  search: Search,
  web: Globe,
  tool: Wrench,
  delegation: Bot,
  other: Ellipsis,
} as const satisfies Record<WorkStep["kind"], LucideIcon>;

/**
 * A turn's work in one line, "Worked for 2m", that opens to every step.
 * Never opens by itself; its steps are read only while it is open.
 */
export function WorkFold({ entry }: { readonly entry: WorkFoldEntry }) {
  const ctx = usePresentation();
  const { plural } = ctx.i18n;
  const { status } = entry;
  const [open, setOpen] = useState(false);
  const failed = status._tag === "finished" && status.ending === "failed";
  const title = workFoldTitle(entry, ctx);
  const count = entry.stepCount > 0 ? plural("work.steps", entry.stepCount) : null;
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.set(withSpring(open ? 1 : 0, reanimatedSpring(springs.pop)));
  }, [open, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
  return (
    <View className="mt-3 px-4">
      <PressScale
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={count === null ? title : `${title}, ${count}`}
        onPress={() => setOpen((was) => !was)}
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
        {/* Running, the line carries a quiet live mark: the bot is still at it. */}
        {status._tag === "running" && <LiveMark />}
        <Text className={`text-xs ${failed ? "text-blocked" : "text-muted-foreground"}`}>
          {title}
        </Text>
        {count !== null && <Text className="text-xs text-muted-foreground">· {count}</Text>}
      </PressScale>
      {open && (
        <AnimatedView entering={opening} exiting={closing}>
          <Steps foldId={entry.id} />
        </AnimatedView>
      )}
    </View>
  );
}

/** The steps fade in as the fold opens and out as it closes; at once under reduced motion. */
const opening = FadeIn.duration(180);
const closing = FadeOut.duration(140);

function Steps({ foldId }: { readonly foldId: WorkFoldEntry["id"] }) {
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
          {/* Long commands and paths wrap: every step reads in full. */}
          {step.kind === "command" ? (
            <Text selectable className="flex-1 text-2xs text-foreground" face="mono">
              {step.label}
            </Text>
          ) : (
            <Text selectable className="flex-1 text-xs text-foreground">
              {stepText(step, i18n)}
            </Text>
          )}
          <StepStatus step={step} />
        </View>
      ))}
    </View>
  );
}

function StepStatus({ step }: { readonly step: WorkStep }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  switch (step.status) {
    case "running":
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
        <View
          accessible
          accessibilityLabel={t("work.stepDone")}
          className="flex-row items-center gap-1.5"
        >
          {step.finishedAt !== null && (
            <Text className="text-2xs text-muted-foreground">
              {shortDuration(millisBetween(step.startedAt, step.finishedAt), ctx.i18n)}
            </Text>
          )}
          <Icon icon={Check} size={14} color="accent-muted-foreground" />
        </View>
      );
  }
}

/**
 * A small dot that breathes while something runs, stepped like the avatars,
 * 8 changes in 1.4 s, so it never repaints every frame; still under reduced
 * motion.
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
