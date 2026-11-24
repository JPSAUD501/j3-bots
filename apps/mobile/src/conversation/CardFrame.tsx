// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCardAction } from "@j3-bots/client-runtime/react";
import type { EntryId } from "@j3-bots/contracts";
import { layout, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { LucideIcon } from "lucide-react-native";
import { type ComponentRef, type ReactNode, use, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import {
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { AnimatedView } from "./animated.ts";
import { EntryWidths } from "./widths.ts";

/** How a card's size eases when its contents change: `slide`, with almost no overshoot. */
const slide = reanimatedSpring(springs.slide);

/** Whether an answer to the card is on its way: it then takes no second one. */
export const useSubmitting = (entryId: EntryId): boolean =>
  useCardAction(entryId)?._tag === "submitting";

/**
 * Once the card no longer waits, moves a screen reader from the control the
 * operator pressed, which goes, to the line that says how the card closed.
 * `answered` marks that the operator answered here; a card closed elsewhere
 * moves nothing. Give `outcome` to that line.
 */
export function useOutcomeFocus(pending: boolean) {
  const outcome = useRef<ComponentRef<typeof Text>>(null);
  const answeredHere = useRef(false);
  const wasPending = useRef(pending);
  useEffect(() => {
    const closed = wasPending.current && !pending;
    wasPending.current = pending;
    if (closed && answeredHere.current && outcome.current !== null) {
      AccessibilityInfo.sendAccessibilityEvent(outcome.current, "focus");
    }
  }, [pending]);
  return {
    outcome,
    answered: () => {
      answeredHere.current = true;
    },
  };
}

/**
 * Whether a card waited for the operator while it was on screen, and whether
 * it has since closed there: a card closed before it showed plays nothing.
 */
export function useClosedHere(pending: boolean): {
  readonly waitedHere: boolean;
  readonly closedHere: boolean;
} {
  const [waitedHere] = useState(pending);
  return { waitedHere, closedHere: waitedHere && !pending };
}

/**
 * The frame of a card that asks the operator for something: an icon in a
 * tile, what the card is about, and while it waits, "Waiting for you" in a
 * calm tag, the frame drawn in the waiting color. In a column narrower than
 * a tablet the card takes the whole column. When its height changes, as its
 * actions fold away, it moves on a spring; `pulse`, once set, gives it one
 * small pulse, as an approval does.
 */
export function CardFrame({
  icon,
  title,
  attention,
  pulse = false,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly attention: boolean;
  readonly pulse?: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const widths = use(EntryWidths);
  const full = widths.column < layout.breakpoints.tablet;
  const scale = useSharedValue(1);
  const pulsing = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  useEffect(() => {
    if (!pulse) return;
    scale.set(
      withSequence(
        withTiming(1.035, { duration: 110 }),
        withSpring(1, reanimatedSpring(springs.pop)),
      ),
    );
  }, [pulse, scale]);
  return (
    <View className="mt-2 px-4">
      <AnimatedView
        layout={LinearTransition.springify()
          .mass(slide.mass)
          .stiffness(slide.stiffness)
          .damping(slide.damping)}
        style={[pulsing, full ? undefined : { maxWidth: widths.card }]}
        className={`gap-2.5 rounded-bubble border bg-surface p-3 ${full ? "self-stretch" : "self-start"} ${attention ? "border-waiting/45" : "border-border"}`}
      >
        <View className="flex-row items-center gap-2.5">
          <View
            className={`size-7 items-center justify-center rounded-md ${attention ? "bg-waiting-surface" : "bg-muted"}`}
          >
            <Icon
              icon={icon}
              size={16}
              color={attention ? "accent-waiting" : "accent-muted-foreground"}
            />
          </View>
          <Text accessibilityRole="header" className="flex-1 text-sm font-semibold text-foreground">
            {title}
          </Text>
          {attention && (
            <Text className="rounded-pill bg-waiting-surface px-2.5 py-0.5 text-2xs font-medium text-waiting">
              {t("card.waiting")}
            </Text>
          )}
        </View>
        {children}
      </AnimatedView>
    </View>
  );
}
