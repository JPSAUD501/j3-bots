// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AvatarState,
  type Featured,
  stageCast,
  type StageLight,
  stageLight,
  type StageScene,
} from "@j3-bots/client-runtime/presentation";
import type { AvatarChoice } from "@j3-bots/contracts";
import { easeOutCurve, motion, reanimatedSpring, springs, stage } from "@j3-bots/design-tokens";
import { type ComponentRef, type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  Ellipse,
  LinearGradient,
  Polygon,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useTint } from "../conversation/tint.ts";
import { useReducedMotion } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { displaySpacing, Text } from "../text.tsx";
import { useColor } from "../theme.ts";

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
const soft = reanimatedSpring(springs.soft);

/**
 * The rig, as the web's stage has it (`Stage.tsx`): how far above a bot's feet
 * its light starts being drawn, and how far above that its lamp hangs, in px.
 */
const RIG = 304;
const LAMP_ABOVE = 28;
/** How much wider than the bot the light's drawing is, each side included, and how tall its pool is, in bot sizes. */
const SPREAD = 3;
const POOL = 0.4;
/** How far a cone's light reaches from its middle at the bot's feet, and how much of that is fully lit, in bot sizes. */
const EDGE = 1.24;
const CORE = 0.42;
/** The cone is drawn as this many cones one inside another, which is what feathers its edge. */
const FEATHER = 7;

/** How strong a bot's light is drawn, and how much of the bot shows, for each way it can be lit. */
const lightLevel = { key: 1, fill: 0.58, spill: 0, shared: 0 } as const satisfies Record<
  StageLight,
  number
>;
const botLevel = { key: 1, fill: 0.94, spill: 0.34, shared: 0.92 } as const satisfies Record<
  StageLight,
  number
>;

/** Where the dust hangs in the lead's cone: across it, in bot sizes from its middle, and how far up the rig. */
const specks = [
  { x: -0.12, y: 0.16, r: 1.1 },
  { x: 0.2, y: 0.3, r: 0.9 },
  { x: -0.26, y: 0.46, r: 1.3 },
  { x: 0.1, y: 0.58, r: 1 },
  { x: -0.06, y: 0.72, r: 0.9 },
  { x: 0.3, y: 0.82, r: 1.2 },
] as const;
/** The dust rises this far, in px, as it shows and goes, in this long, and starts over. */
const DUST_RISE = 26;
const DUST_PERIOD = 7000;

/**
 * A bot's light, drawn the way stage light is seen, as on the web: a cone
 * through the air from a lamp above the stage, strongest by the lamp and soft
 * at its edge, an oval pool where it lands, and the floor dark where the bot
 * stands. It is of the bot's own color, so it shows on a light canvas and on
 * a dark one.
 *
 * `light` says how the bot is lit, and the light crosses over to it on the
 * `out` ease; it first comes up `stage.spotLead` ms before the bot sets off,
 * `delay` ms after the stage first shows. `tight` closes it while a form has
 * the operator's eye. `swells` plays the finale: wider, and settling again.
 * `dusty` hangs a little dust in the cone, which rises slowly and stands
 * still under reduced motion.
 */
export function Light({
  look,
  size,
  delay,
  light,
  tight = false,
  swells = false,
  dusty = false,
  rig = RIG,
}: {
  readonly look: AvatarChoice;
  readonly size: number;
  readonly delay: number;
  readonly light: StageLight;
  readonly tight?: boolean;
  readonly swells?: boolean;
  readonly dusty?: boolean;
  /** How far above the bot's feet the light starts being drawn, in px: the whole rig unless the stage is drawn smaller. */
  readonly rig?: number;
}) {
  const color = useTint(look).color;
  const id = useId();
  const reduced = useReducedMotion();
  const level = lightLevel[light];
  const lit = useSharedValue(0);
  const first = useRef(true);
  useEffect(() => {
    const to = withTiming(level, { duration: stage.spotIn, easing: easeOut });
    lit.set(first.current ? withDelay(delay, to) : to);
    first.current = false;
  }, [level, delay, lit]);
  const width = useSharedValue(tight ? 0.66 : 1);
  useEffect(() => {
    if (swells && !reduced) {
      width.set(
        withSequence(
          withTiming(1.5, { duration: stage.swell * 0.28, easing: easeOut }),
          withTiming(1.12, { duration: stage.swell * 0.72, easing: easeOut }),
        ),
      );
    } else width.set(reduced ? (tight ? 0.66 : 1) : withSpring(tight ? 0.66 : 1, soft));
  }, [tight, swells, reduced, width]);
  const dust = useSharedValue(0);
  useEffect(() => {
    if (!dusty || reduced) {
      dust.set(0.5);
      return;
    }
    dust.set(0);
    dust.set(withRepeat(withTiming(1, { duration: DUST_PERIOD, easing: Easing.linear }), -1));
  }, [dusty, reduced, dust]);
  const style = useAnimatedStyle(() => ({
    opacity: lit.get(),
    transform: [{ scaleX: width.get() }],
  }));
  const dustStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(dust.get() * Math.PI),
    transform: [{ translateY: (0.5 - dust.get()) * DUST_RISE }],
  }));

  const across = size * SPREAD;
  const middle = across / 2;
  const pool = size * POOL;
  const height = rig + pool / 2;
  const lamp = (LAMP_ABOVE * rig) / RIG;
  // A cone from the lamp, `reach` wide from its middle at the bot's feet: at the top of the
  // drawing, which is under the lamp, it is already a little open.
  const cone = (reach: number) => {
    const top = (reach * lamp) / (rig + lamp);
    return `${middle - top},0 ${middle + top},0 ${middle + reach},${rig} ${middle - reach},${rig}`;
  };
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: (size - across) / 2,
          bottom: -pool / 2,
          width: across,
          height,
          transformOrigin: "center bottom",
        },
        style,
      ]}
    >
      <Svg width={across} height={height}>
        <Defs>
          <LinearGradient id={`${id}fall`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.1" stopColor={color} stopOpacity={1} />
            <Stop offset="0.48" stopColor={color} stopOpacity={0.6} />
            <Stop offset="0.86" stopColor={color} stopOpacity={0.3} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
          <RadialGradient id={`${id}pool`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={color} stopOpacity={0.5} />
            <Stop offset="0.36" stopColor={color} stopOpacity={0.3} />
            <Stop offset="0.7" stopColor={color} stopOpacity={0.1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${id}shadow`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity={0.42} />
            <Stop offset="0.55" stopColor="#000" stopOpacity={0.2} />
            <Stop offset="1" stopColor="#000" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {Array.from({ length: FEATHER }, (_, layer) => (
          <Polygon
            key={layer}
            points={cone(size * EDGE * (1 - ((1 - CORE) * layer) / (FEATHER - 1)))}
            fill={`url(#${id}fall)`}
            opacity={0.3 / FEATHER}
          />
        ))}
        <Ellipse cx={middle} cy={rig} rx={size * 1.3} ry={pool / 2} fill={`url(#${id}pool)`} />
        <Ellipse
          cx={middle}
          cy={rig + size * 0.02}
          rx={size * 0.43}
          ry={size * 0.08}
          fill={`url(#${id}shadow)`}
        />
      </Svg>
      {dusty && (
        <Animated.View style={[{ position: "absolute", left: 0, top: 0 }, dustStyle]}>
          {specks.map((speck) => (
            <View
              key={speck.y}
              style={{
                position: "absolute",
                left: middle + speck.x * size - speck.r,
                top: speck.y * rig - speck.r,
                width: speck.r * 2,
                height: speck.r * 2,
                borderRadius: speck.r,
                backgroundColor: color,
                opacity: 0.55,
              }}
            />
          ))}
        </Animated.View>
      )}
    </Animated.View>
  );
}

/**
 * The one light the whole cast shares while it thinks, in place of a light
 * each: one wide cone from one lamp over a stage `width` wide, cool where
 * theirs are warm, breathing slowly, and its pool across the floor. `on`
 * brings it up and takes it down.
 */
function SharedLight({
  on,
  width,
  floor,
}: {
  readonly on: boolean;
  readonly width: number;
  /** How far above the stage's bottom the cast stands, in px. */
  readonly floor: number;
}) {
  const color = useColor("accent-bot-sky");
  const id = useId();
  const reduced = useReducedMotion();
  const lit = useSharedValue(0);
  useEffect(() => {
    lit.set(withTiming(on ? 1 : 0, { duration: motion.slow, easing: easeOut }));
  }, [on, lit]);
  const breath = useSharedValue(1);
  useEffect(() => {
    if (!on || reduced) {
      breath.set(1);
      return;
    }
    breath.set(
      withRepeat(withTiming(0.76, { duration: 3600, easing: Easing.inOut(Easing.ease) }), -1, true),
    );
  }, [on, reduced, breath]);
  const style = useAnimatedStyle(() => ({ opacity: lit.get() * breath.get() }));
  const middle = width / 2;
  const pool = 56;
  const height = RIG + pool / 2;
  const cone = (reach: number) => {
    const top = (reach * LAMP_ABOVE) / (RIG + LAMP_ABOVE);
    return `${middle - top},0 ${middle + top},0 ${middle + reach},${RIG} ${middle - reach},${RIG}`;
  };
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, bottom: floor - pool / 2, width, height }, style]}
    >
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={`${id}fall`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.1" stopColor={color} stopOpacity={1} />
            <Stop offset="0.48" stopColor={color} stopOpacity={0.6} />
            <Stop offset="0.86" stopColor={color} stopOpacity={0.3} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
          <RadialGradient id={`${id}pool`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={color} stopOpacity={0.26} />
            <Stop offset="0.52" stopColor={color} stopOpacity={0.12} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {Array.from({ length: FEATHER }, (_, layer) => (
          <Polygon
            key={layer}
            points={cone(width * 0.62 * (1 - ((1 - CORE) * layer) / (FEATHER - 1)))}
            fill={`url(#${id}fall)`}
            opacity={0.24 / FEATHER}
          />
        ))}
        <Ellipse cx={middle} cy={RIG} rx={width * 0.56} ry={pool / 2} fill={`url(#${id}pool)`} />
      </Svg>
    </Animated.View>
  );
}

/** A bot of the cast, which shows as much as its light lets it: one with no light of its own stands back, dark. */
function Lit({ light, children }: { readonly light: StageLight; readonly children: ReactNode }) {
  const level = botLevel[light];
  const shown = useSharedValue<number>(level);
  useEffect(() => {
    shown.set(withTiming(level, { duration: motion.slow, easing: easeOut }));
  }, [level, shown]);
  const style = useAnimatedStyle(() => ({ opacity: shown.get() }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** The stage as it is before the first run's steps set it: every bot in its own light. */
const everyoneLit: StageScene = { camera: "wide", cast: "lit", spot: "open", named: false };

/** How wide the stage is drawn, in px: `w-72`. */
const STAGE_WIDTH = 288;

/**
 * The team still to come, standing on a stage: each bot comes down into its
 * own light after the one before, lands and lights its antenna, which is the
 * avatar's own entrance. `scene` sets its lights as the web's stage does
 * (`StageScene`): each in its own, one at a time as each says what it does
 * (`featured`), or all under the one light they share while they think.
 * `compact` is for screens with a form under it. `leadRef` is the first bot's
 * place, which the bot being made leaves from and comes back to, and `look`
 * what that bot wears: the look picked for the bot being made, once one is.
 */
export function Cast({
  compact = false,
  lead = "pops",
  leadRef,
  scene = everyoneLit,
  featured = "all",
  look = stageCast[0].look,
}: {
  readonly compact?: boolean;
  readonly lead?: Lead;
  readonly leadRef?: Ref<ComponentRef<typeof View>>;
  readonly look?: AvatarChoice;
  readonly scene?: StageScene;
  readonly featured?: Featured;
}) {
  const scale = compact ? 0.72 : 1;
  const actors = useRef(new Map<number, AvatarHandle>());
  // A bot whose turn in the light comes steps up to it; when it is everyone's, they all do.
  const turns = scene.cast === "turns";
  useEffect(() => {
    if (!turns) return;
    if (featured === "all") for (const actor of actors.current.values()) actor.poke("nod");
    else actors.current.get(featured)?.poke("hop");
  }, [turns, featured]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={compact ? "h-32 w-72" : "h-48 w-72"}
    >
      <SharedLight on={scene.cast === "thinking"} width={STAGE_WIDTH} floor={FLOOR} />
      {stageCast.map((member, index) => {
        const size = Math.round(member.size * scale);
        const first = index === 0;
        const delay = index * stage.stagger;
        const light = stageLight(scene, index, featured);
        const wears = first ? look : member.look;
        const state: AvatarState =
          scene.cast === "thinking"
            ? "thinking"
            : turns && featured === index
              ? "speaking"
              : "idle";
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
            <Light
              look={wears}
              size={size}
              delay={delay}
              light={light}
              dusty={first}
              rig={RIG * scale}
            />
            <Lit light={light}>
              <Animated.View {...(first && lead === "after" ? { entering: landed } : {})}>
                <BotAvatar
                  ref={(handle) => {
                    if (handle === null) return;
                    actors.current.set(index, handle);
                    return () => {
                      actors.current.delete(index);
                    };
                  }}
                  avatar={wears}
                  seed={first ? "first-bot" : `cast-${member.look.shape}`}
                  state={state}
                  size={size}
                  entrance={!(first && lead === "after") && { delay: delay + stage.spotLead }}
                />
              </Animated.View>
            </Lit>
          </View>
        );
      })}
    </View>
  );
}
