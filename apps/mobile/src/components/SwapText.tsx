// SPDX-License-Identifier: AGPL-3.0-or-later
import { easeOutCurve, motion } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useReducedMotion } from "../motion.ts";
import { Text } from "../text.tsx";

/** `eases.out` as Reanimated takes it. */
const out = Easing.bezier(...easeOutCurve);

/** How far a line travels as it comes and goes, in px: about a third of its height. */
const TRAVEL = 6;

interface Line {
  readonly key: number;
  readonly text: string;
  readonly rising: boolean;
  readonly leaving: boolean;
}

/**
 * One line of status that changes in place, as on the web: the old line
 * leaves upward as the new one rises in, on `motion.swap` and the `out`
 * ease. The first line, and every line under reduced motion, shows as it is.
 * Only the current line reaches TalkBack. The line keeps one line's height
 * and ends what does not fit with an ellipsis.
 */
export function SwapText({
  text,
  className = "",
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<{
    readonly text: string;
    readonly lines: ReadonlyArray<Line>;
  }>(() => ({ text, lines: [{ key: 0, text, rising: false, leaving: false }] }));
  if (state.text !== text) {
    const key = (state.lines.at(-1)?.key ?? 0) + 1;
    const next: Line = { key, text, rising: true, leaving: false };
    setState({
      text,
      lines: reduced
        ? [{ ...next, rising: false }]
        : [
            ...state.lines
              .filter((line) => !line.leaving)
              .map((line) => ({ ...line, leaving: true })),
            next,
          ],
    });
  }
  const gone = (key: number) =>
    setState((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.key !== key),
    }));
  return (
    <View className="overflow-hidden">
      {/* Holds the line's height and width; the lines that move lie over it. */}
      <Text
        numberOfLines={1}
        className={className}
        style={styles.hidden}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {text}
      </Text>
      {state.lines.map((line) => (
        <SwapLine key={line.key} line={line} className={className} onGone={() => gone(line.key)} />
      ))}
    </View>
  );
}

function SwapLine({
  line,
  className,
  onGone,
}: {
  readonly line: Line;
  readonly className: string;
  readonly onGone: () => void;
}) {
  // -1 gone above, 0 in place, 1 still below.
  const place = useSharedValue(line.rising ? 1 : 0);
  const done = useEffectEvent(onGone);
  useEffect(() => {
    if (line.leaving) {
      place.set(
        withTiming(-1, { duration: motion.swap, easing: out }, (finished) => {
          if (finished === true) scheduleOnRN(done);
        }),
      );
    } else if (line.rising) {
      place.set(withTiming(0, { duration: motion.swap, easing: out }));
    }
  }, [line.leaving, line.rising, place]);
  const style = useAnimatedStyle(() => ({
    opacity: 1 - Math.abs(place.get()),
    transform: [{ translateY: place.get() * TRAVEL }],
  }));
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, style]}
      accessibilityElementsHidden={line.leaving}
      importantForAccessibility={line.leaving ? "no-hide-descendants" : "auto"}
    >
      <Text numberOfLines={1} className={className}>
        {line.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ hidden: { opacity: 0 } });
