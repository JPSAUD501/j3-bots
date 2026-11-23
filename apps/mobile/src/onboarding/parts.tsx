// SPDX-License-Identifier: AGPL-3.0-or-later
import { firstLooks } from "@j3-bots/client-runtime/presentation";
import type { AvatarChoice } from "@j3-bots/contracts";
import { type ComponentRef, type ReactNode, useEffect, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { BotAvatar } from "../components/Avatar.tsx";
import { popIn, useReducedMotion } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { displaySpacing, Text } from "../text.tsx";

// What the screens before the first bot share: pairing, and the steps that make it.

const idle = { _tag: "idle" } as const;

/**
 * The app's filled text field, at the larger height of the screens before the
 * first bot. The caller sets the type size: two sizes in one class list do not
 * say which one wins.
 */
export const bigFieldClass = "min-h-13 rounded-md border bg-muted px-4 text-foreground";

/** A step's title, or the larger display line of the welcome and the arrival, in the display face. */
const titleSizes = {
  title: { className: "text-3xl", spacing: displaySpacing(30) },
  display: { className: "text-4xl", spacing: displaySpacing(40) },
} as const;

/** A screen's title; it takes a screen reader's focus when the screen comes in. */
export function StepTitle({
  children,
  size = "title",
}: {
  readonly children: ReactNode;
  readonly size?: keyof typeof titleSizes;
}) {
  const { className, spacing } = titleSizes[size];
  const ref = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (ref.current !== null) AccessibilityInfo.sendAccessibilityEvent(ref.current, "focus");
  }, []);
  return (
    <Text
      ref={ref}
      accessibilityRole="header"
      face="display"
      className={`text-center text-foreground ${className}`}
      style={{ letterSpacing: spacing }}
    >
      {children}
    </Text>
  );
}

/** The one action of a screen before the first bot. A disabled one stays readable and takes no press. */
export function BigButton({
  label,
  onPress,
  disabled = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-13 items-center justify-center rounded-pill bg-accent px-6 ${disabled ? "opacity-50" : ""}`}
    >
      <Text className="text-lg font-semibold text-accent-foreground">{label}</Text>
    </PressScale>
  );
}

interface CastMember {
  readonly look: AvatarChoice;
  readonly size: number;
  /** Where its centre sits, in % of the cast's box. */
  readonly x: number;
  readonly y: number;
  /** How long one float takes, in ms: each its own, so no two move together. */
  readonly float: number;
}

const at = (index: number): AvatarChoice => firstLooks[index % firstLooks.length] ?? firstLooks[0];

const cast: ReadonlyArray<CastMember> = [
  { look: at(0), size: 96, x: 50, y: 40, float: 3400 },
  { look: at(3), size: 64, x: 17, y: 52, float: 2900 },
  { look: at(1), size: 68, x: 83, y: 50, float: 3700 },
  { look: at(2), size: 60, x: 33, y: 76, float: 3100 },
  { look: at(5), size: 52, x: 69, y: 80, float: 2700 },
];

/**
 * The team still to come: each bot pops in after the one before, then floats
 * on its own clock. `compact` is for screens with a form under it.
 */
export function Cast({ compact = false }: { readonly compact?: boolean }) {
  const reduced = useReducedMotion();
  const scale = compact ? 0.72 : 1;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={compact ? "h-32 w-72" : "h-48 w-72"}
    >
      {cast.map((member, index) => {
        const size = Math.round(member.size * scale);
        return (
          <View
            key={`${member.look.shape}/${member.look.color}`}
            className="absolute"
            style={{
              left: `${member.x}%`,
              top: `${member.y}%`,
              marginLeft: -size / 2,
              marginTop: -size / 2,
            }}
          >
            <Animated.View entering={popIn(90 * index)}>
              <Float period={member.float} still={reduced}>
                <BotAvatar avatar={member.look} state={idle} size={size} />
              </Float>
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}

function Float({
  period,
  still,
  children,
}: {
  readonly period: number;
  readonly still: boolean;
  readonly children: ReactNode;
}) {
  const y = useSharedValue(0);
  useEffect(() => {
    if (still) {
      y.set(0);
      return;
    }
    y.set(
      withRepeat(
        withSequence(
          withTiming(-6, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      ),
    );
  }, [period, still, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
