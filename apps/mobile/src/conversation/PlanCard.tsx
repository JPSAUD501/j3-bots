// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  liveLine,
  type PlanLine as Line,
  planLines,
  planProgress,
  planWindow,
} from "@j3-bots/client-runtime/presentation";
import { planStepText, planTitle } from "@j3-bots/client-runtime/wording";
import type { Plan } from "@j3-bots/contracts";
import { type BotColor, avatarBodyColor, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { Check, ChevronRight } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useUniwind } from "uniwind";
import { Icon } from "../components/Icon.tsx";
import { SwapText } from "../components/SwapText.tsx";
import { useI18n } from "../i18n.ts";
import { enteringWhen, popIn, settleIn, useReducedMotion, useStep } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { AnimatedView } from "./animated.ts";

/** How tall one step's line is in the running card, in px: the live mark travels by it. */
const LINE = 28;

const slide = reanimatedSpring(springs.slide);
const pop = reanimatedSpring(springs.pop);

/**
 * A step's mark: a ring for one still to do, a check for one done. A step
 * that ends while its card is on screen pops its check in. The step being
 * done now shows no mark of its own: the card's live mark stands on it.
 */
function StepMark({ line, live }: { readonly line: Line; readonly live: boolean }) {
  // Whether it was done when first drawn: only one that ends in front of the operator pops.
  const [doneAtFirst] = useState(line.state === "done");
  if (line.state === "done") {
    return (
      <AnimatedView
        {...enteringWhen(!doneAtFirst, popIn())}
        className="size-4 items-center justify-center rounded-pill bg-muted"
      >
        <Icon icon={Check} size={10} color="accent-foreground" />
      </AnimatedView>
    );
  }
  return (
    <View className="size-4 items-center justify-center">
      {!live && (
        <View className="size-2.5 rounded-pill border-[1.5px] border-muted-foreground/60" />
      )}
    </View>
  );
}

/**
 * The one live mark of a running plan, as on the web: a ring in the bot's
 * color with a dot that breathes, on the step being done now. It goes from the
 * step that ended to the one that starts on `slide`, which carries its speed
 * over when the plan moves on before it has arrived. It pops in where the
 * first step runs, and goes while none does.
 */
function LiveMark({ at, color }: { readonly at: number | null; readonly color: string }) {
  const reduced = useReducedMotion();
  const y = useSharedValue((at ?? 0) * LINE);
  const shown = useSharedValue(at === null || !reduced ? 0 : 1);
  const placed = useRef(at !== null);
  useEffect(() => {
    if (at === null) {
      shown.set(reduced ? 0 : withTiming(0, { duration: 200 }));
      placed.current = false;
      return;
    }
    // Where it first shows it is simply there; after that it travels.
    y.set(placed.current && !reduced ? withSpring(at * LINE, slide) : at * LINE);
    shown.set(reduced ? 1 : withSpring(1, pop));
    placed.current = true;
  }, [at, reduced, shown, y]);
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateY: y.get() }, { scale: 0.3 + 0.7 * shown.get() }],
    opacity: Math.min(1, Math.max(0, shown.get())),
  }));
  // The dot breathes in steps, as the live mark of a running step does.
  const step = useStep(1400, 8, !reduced && at !== null);
  const depth = 1 - Math.abs(step - 4) / 4;
  return (
    <AnimatedView
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, top: 0, width: 16, height: LINE }, moved]}
      className="items-center justify-center"
    >
      <View
        style={{ borderColor: color }}
        className="size-[13px] items-center justify-center rounded-pill border-[1.5px] bg-surface"
      >
        <View
          style={{
            backgroundColor: color,
            opacity: 1 - 0.65 * depth,
            transform: [{ scale: 1 - 0.3 * depth }],
          }}
          className="size-[5px] rounded-pill"
        />
      </View>
    </AnimatedView>
  );
}

/**
 * A running turn's plan, as on the web: a short card under the turn's line,
 * each step one line, the done ones checked, the one being done now carrying
 * the live mark. A long plan shows around where the bot is, with a line that
 * counts the steps before and one for those after. `tint` is the bot's color.
 */
export function PlanCard({ plan, tint }: { readonly plan: Plan; readonly tint: BotColor }) {
  const i18n = useI18n();
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  const shown = planWindow(plan);
  const lead = shown.before > 0 ? 1 : 0;
  const live = liveLine(shown.lines);
  return (
    <AnimatedView
      entering={settleIn(springs.soft)}
      accessibilityLabel={planTitle(planProgress(plan), i18n)}
      style={{ marginStart: 34 }}
      className="mt-0.5 mb-1 rounded-lg border border-border bg-surface py-1 ps-2.5 pe-3"
    >
      <View>
        {shown.before > 0 && <CountLine text={i18n.plural("plan.before", shown.before)} />}
        {shown.lines.map((line, at) => (
          <View
            key={line.index}
            accessible
            accessibilityLabel={`${planStepText(line.state, i18n)}: ${line.text}`}
            style={{ height: LINE }}
            className="flex-row items-center gap-2.5"
          >
            <StepMark line={line} live={live === at} />
            <View className="min-w-0 flex-1">
              <SwapText
                text={line.text}
                className={`text-xs ${line.state === "running" ? "font-medium text-foreground" : "text-muted-foreground"}`}
              />
            </View>
          </View>
        ))}
        {shown.after > 0 && <CountLine text={i18n.plural("plan.after", shown.after)} />}
        <LiveMark
          at={live === null ? null : live + lead}
          color={avatarBodyColor(tint, theme, false)}
        />
      </View>
    </AnimatedView>
  );
}

/** A line of the card that counts the steps not shown before or after those it shows. */
function CountLine({ text }: { readonly text: string }) {
  return (
    <View style={{ height: LINE, paddingStart: 26 }} className="justify-center">
      <Text className="text-2xs text-muted-foreground">{text}</Text>
    </View>
  );
}

/** The steps fade in as the line opens and out as it closes; at once under reduced motion. */
const opening = FadeIn.duration(180);
const closing = FadeOut.duration(140);

/**
 * What a turn's plan settles into once the turn is over: one quiet line,
 * "Plan done, 4 of 4", that opens every step. `folding` when the turn ended
 * while on screen: the line settles in, as the turn's own line does.
 */
export function PlanLine({ plan, folding }: { readonly plan: Plan; readonly folding: boolean }) {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.set(withSpring(open ? 1 : 0, pop));
  }, [open, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
  return (
    <AnimatedView {...enteringWhen(folding, settleIn(springs.pop))}>
      <PressScale
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        frame={{ alignSelf: "flex-start", marginStart: -8 }}
        className="min-h-11 flex-row items-center gap-1.5 rounded-md px-2"
      >
        <AnimatedView style={chevron}>
          <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
        </AnimatedView>
        <Text className="text-xs text-muted-foreground">{planTitle(planProgress(plan), i18n)}</Text>
      </PressScale>
      {open && (
        <AnimatedView entering={opening} exiting={closing}>
          <View className="ms-1.5 border-s border-border ps-3">
            {planLines(plan).map((line) => (
              <View
                key={line.index}
                accessible
                accessibilityLabel={`${planStepText(line.state, i18n)}: ${line.text}`}
                className="min-h-7 flex-row items-start gap-2.5 py-1"
              >
                <StepMark line={line} live={false} />
                <Text
                  selectable
                  className={`flex-1 text-xs ${line.state === "running" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {line.text}
                </Text>
              </View>
            ))}
          </View>
        </AnimatedView>
      )}
    </AnimatedView>
  );
}
