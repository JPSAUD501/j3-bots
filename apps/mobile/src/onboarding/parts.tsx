// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarChoice } from "@j3-bots/contracts";
import { avatarCast, easeOutCurve, springs, stage } from "@j3-bots/design-tokens";
import { type ComponentRef, type ReactNode, type Ref, useEffect, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useTint } from "../conversation/tint.ts";
import { PressScale } from "../press.tsx";
import { displaySpacing, Text } from "../text.tsx";

// What the screens before the first bot share: pairing, and the steps that make it.

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
  /** Where it stands across the stage, in % of its width. */
  readonly x: number;
  /** How far upstage it stands: each step back is a little higher. */
  readonly depth: 0 | 1 | 2;
}

/** The cast's look at `index`: the first is the one the first bot starts with. */
const at = (index: number): AvatarChoice => avatarCast[index % avatarCast.length] ?? avatarCast[0];

/** The cast: the lead at the front, in the middle, and four more around and behind it, in the order they come in. */
const cast: ReadonlyArray<CastMember> = [
  { look: at(0), size: 96, x: 50, depth: 0 },
  { look: at(3), size: 60, x: 16, depth: 1 },
  { look: at(1), size: 64, x: 84, depth: 1 },
  { look: at(2), size: 50, x: 31, depth: 2 },
  { look: at(5), size: 46, x: 70, depth: 2 },
];

/** How far above the stage's bottom the floor is, and how much higher each step upstage stands, in px. */
const FLOOR = 20;
const UPSTAGE = 11;

/**
 * How the cast's first bot is shown: coming down with the rest, not at all
 * while the bot being made stands for it, or once the bot being made has been
 * carried back into its place.
 */
export type Lead = "pops" | "away" | "after";

/** The cast's first bot showing in its place, the moment the bot being made lands there. */
const landed = FadeIn.delay(springs.slide.duration).duration(1);

const easeOut = Easing.bezier(...easeOutCurve);

/**
 * A bot's light: a pool of its own color at its feet, which comes up
 * `stage.spotLead` ms before the bot sets off, `delay` ms after the stage
 * first shows.
 */
export function Pool({
  look,
  size,
  delay,
}: {
  readonly look: AvatarChoice;
  readonly size: number;
  readonly delay: number;
}) {
  const backgroundColor = useTint(look).color;
  const lit = useSharedValue(0);
  useEffect(() => {
    lit.set(withDelay(delay, withTiming(1, { duration: stage.spotIn, easing: easeOut })));
  }, [delay, lit]);
  const style = useAnimatedStyle(() => ({ opacity: 0.26 * lit.get() }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: -size * 0.32,
          right: -size * 0.32,
          bottom: -size * 0.13,
          height: size * 0.34,
          borderRadius: size,
          backgroundColor,
        },
        style,
      ]}
    />
  );
}

/**
 * The team still to come, standing on a stage: each bot comes down into its
 * own light after the one before, lands and lights its antenna, which is the
 * avatar's own entrance. `compact` is for screens with a form under it.
 * `leadRef` is the first bot's place, which the bot being made leaves from and
 * comes back to.
 */
export function Cast({
  compact = false,
  lead = "pops",
  leadRef,
}: {
  readonly compact?: boolean;
  readonly lead?: Lead;
  readonly leadRef?: Ref<ComponentRef<typeof View>>;
}) {
  const scale = compact ? 0.72 : 1;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={compact ? "h-32 w-72" : "h-48 w-72"}
    >
      {cast.map((member, index) => {
        const size = Math.round(member.size * scale);
        const first = index === 0;
        const delay = index * stage.stagger;
        return (
          <View
            key={`${member.look.shape}/${member.look.color}`}
            ref={first ? leadRef : undefined}
            className="absolute"
            style={{
              left: `${member.x}%`,
              bottom: FLOOR + member.depth * UPSTAGE * scale,
              marginLeft: -size / 2,
              width: size,
              height: size,
              zIndex: 3 - member.depth,
              opacity: first && lead === "away" ? 0 : 1,
            }}
          >
            <Pool look={member.look} size={size} delay={delay} />
            <Animated.View {...(first && lead === "after" ? { entering: landed } : {})}>
              <BotAvatar
                avatar={member.look}
                seed={`cast-${member.look.shape}`}
                state="idle"
                size={size}
                entrance={!(first && lead === "after") && { delay: delay + stage.spotLead }}
              />
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}
