// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";
import {
  botPalette,
  colors,
  easeOutCurve,
  motion,
  reanimatedSpring,
  resolveAvatar,
  rowLightColors,
  springs,
  stage,
} from "@j3-bots/design-tokens";
import { useEffect, useId, useState } from "react";
import type { ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
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
import { scheduleOnRN } from "react-native-worklets";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import type { AvatarEntrance } from "./avatar/BotAvatar.tsx";

const easeOut = Easing.bezier(...easeOutCurve);
const soft = reanimatedSpring(springs.soft);

/** A row's avatar, in px, and how far its light reaches past it on each side. */
const AVATAR = 40;
const REACH = 16;
/**
 * The light, as the web draws it (`.row-light` in its `index.css`): a lamp
 * this many row heights above the row, a cone whose light ends this far from
 * its middle, fully lit over `CORE` of that, drawn as `FEATHER` cones one
 * inside another to soften its edge.
 */
const LAMP_ABOVE = 0.45;
const CONE = Math.tan((21 * Math.PI) / 180);
const CORE = 0.42;
const FEATHER = 7;
/** The pool at the bot's feet and the dark under it once it stands there, as radii in px. */
const POOL = { rx: 32, ry: 7 } as const;
const SHADOW = { rx: 18, ry: 3.2 } as const;
/** The row's words come in from this far below, in px. */
const RISE = 4;

/** A style the UI thread drives. */
type DrivenStyle = ReturnType<typeof useAnimatedStyle<ViewStyle>>;

/** What a row new to the roster draws for its arrival, and how its parts move. */
export interface RowArrival {
  /** The light is drawn and the avatar clipped to the row: its arrival is under way. */
  readonly staged: boolean;
  /** The bot's entrance, which sets off once the light is up and lands the row with it. */
  readonly avatarEntrance: false | AvatarEntrance;
  /** Set as the bot lands. */
  readonly landed: SharedValue<boolean>;
  /** How strongly the light is drawn: it goes down after the landing. */
  readonly light: SharedValue<number>;
  readonly name: DrivenStyle;
  readonly line: DrivenStyle;
  /** The whole row's, for the calm fade under reduced motion. */
  readonly frame: DrivenStyle;
}

/**
 * A row's arrival, as one moment keyed to its bot's landing, as on the web
 * (`RosterRow`) and as the first run stages its cast (`stage`): the light
 * comes up first, the bot sets off `stage.spotLead` ms later and comes down
 * into it, the avatar clipped to the row's own height so it never crosses the
 * row above; as it lands its name and then its line come in and, a moment
 * later, the light goes down. All of it runs on the UI thread from the
 * avatar's own landing, so the light never goes down before the bot is
 * there; a bot no frame draws counts as landed after `stage.rowLand`. Under
 * reduced motion the row fades in.
 */
export function useRowArrival(entrance: boolean): RowArrival {
  const reduced = useReducedMotion();
  const [arriving, setArriving] = useState(entrance);
  const staged = arriving && !reduced;
  const landed = useSharedValue(false);
  const light = useSharedValue(1);
  const name = useSharedValue(entrance ? 0 : 1);
  const line = useSharedValue(entrance ? 0 : 1);
  const shown = useSharedValue(1);

  useEffect(() => {
    if (!staged) return;
    const late = setTimeout(() => landed.set(true), stage.spotLead + stage.rowLand);
    return () => clearTimeout(late);
  }, [staged, landed]);

  useEffect(() => {
    if (!arriving || !reduced) return;
    name.set(1);
    line.set(1);
    shown.set(0);
    shown.set(
      withTiming(
        1,
        { duration: motion.state, easing: easeOut, reduceMotion: ReduceMotion.Never },
        (finished) => {
          if (finished === true) scheduleOnRN(setArriving, false);
        },
      ),
    );
  }, [arriving, reduced, name, line, shown]);

  useAnimatedReaction(
    () => landed.get(),
    (now, before) => {
      if (!now || before === true) return;
      name.set(withSpring(1, soft));
      line.set(withDelay(stage.focus.gap, withSpring(1, soft)));
      light.set(
        withDelay(
          stage.rowHold,
          withTiming(0, { duration: stage.rowDim, easing: easeOut }, (finished) => {
            if (finished === true) scheduleOnRN(setArriving, false);
          }),
        ),
      );
    },
  );

  const nameStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: name.get(),
    transform: [{ translateY: (1 - name.get()) * RISE }],
  }));
  const lineStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: line.get(),
    transform: [{ translateY: (1 - line.get()) * RISE }],
  }));
  const frame = useAnimatedStyle<ViewStyle>(() => ({ opacity: shown.get() }));
  return {
    staged,
    avatarEntrance: staged ? { delay: stage.spotLead, landed } : false,
    landed,
    light,
    name: nameStyle,
    line: lineStyle,
    frame,
  };
}

/**
 * How the avatar's place is clipped to a row `height` tall while it arrives:
 * as large as the row, around the avatar, with nothing around it moved.
 */
export const arrivalClip = (height: number): ViewStyle => {
  const ceiling = (height - AVATAR) / 2;
  return {
    overflow: "hidden",
    marginVertical: -ceiling,
    paddingVertical: ceiling,
    marginHorizontal: -REACH,
    paddingHorizontal: REACH,
  };
};

/**
 * A new row's light, behind its avatar, drawn the way the first run draws a
 * bot's (`Light` in the onboarding): a cone from a lamp above the row, soft
 * at its edge and thinning toward the floor, an oval pool at the bot's feet
 * that takes its landing, and the floor dark under it once it stands there.
 * It is of the bot's own color on a light canvas and a warm white taking some
 * of it on a dark one, as on the web (`rowLightColors`), and stays within the
 * row's own height.
 */
export function RowLight({
  avatar,
  height,
  arrival,
}: {
  /** The bot's, or a room's first member's: the light's color. */
  readonly avatar: Avatar | null;
  /** The row's height, in px. */
  readonly height: number;
  readonly arrival: RowArrival;
}) {
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  const tone = rowLightColors(
    avatar === null ? colors.foreground[theme] : botPalette[resolveAvatar(avatar).color][theme],
    theme,
  );
  const id = useId();
  const { landed, light } = arrival;
  const lit = useSharedValue(0);
  const shadow = useSharedValue(0);
  const pool = useSharedValue(1);
  useEffect(() => {
    lit.set(withTiming(1, { duration: stage.spotIn, easing: easeOut }));
  }, [lit]);
  useAnimatedReaction(
    () => landed.get(),
    (now, before) => {
      if (!now || before === true) return;
      shadow.set(withTiming(1, { duration: motion.slow, easing: easeOut }));
      pool.set(
        withSequence(withTiming(1.2, { duration: 120, easing: easeOut }), withSpring(1, soft)),
      );
    },
  );
  const lightStyle = useAnimatedStyle(() => ({ opacity: lit.get() * light.get() }));
  const poolStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: pool.get() }] }));
  const shadowStyle = useAnimatedStyle(() => ({ opacity: shadow.get() }));

  const width = AVATAR + 2 * REACH;
  const middle = width / 2;
  const ceiling = (height - AVATAR) / 2;
  const feet = ceiling + AVATAR;
  const lamp = -LAMP_ABOVE * height;
  const cone = (share: number) => {
    const top = -lamp * CONE * share;
    const bottom = (feet - lamp) * CONE * share;
    return `${middle - top},0 ${middle + top},0 ${middle + bottom},${feet} ${middle - bottom},${feet}`;
  };
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: -REACH, top: -ceiling, width, height }, lightStyle]}
    >
      <Svg width={width} height={feet}>
        <Defs>
          <LinearGradient id={`${id}fall`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tone.beam} stopOpacity={1} />
            <Stop offset="0.55" stopColor={tone.beam} stopOpacity={0.6} />
            <Stop offset="1" stopColor={tone.beam} stopOpacity={0.3} />
          </LinearGradient>
        </Defs>
        {Array.from({ length: FEATHER }, (_, layer) => (
          <Polygon
            key={layer}
            points={cone(1 - ((1 - CORE) * layer) / (FEATHER - 1))}
            fill={`url(#${id}fall)`}
            opacity={0.34 / FEATHER}
          />
        ))}
      </Svg>
      <Animated.View
        style={[{ position: "absolute", left: middle - POOL.rx, top: feet - POOL.ry }, poolStyle]}
      >
        <Svg width={POOL.rx * 2} height={POOL.ry * 2}>
          <Defs>
            <RadialGradient id={`${id}pool`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={tone.lamp} stopOpacity={0.58} />
              <Stop offset="0.36" stopColor={tone.beam} stopOpacity={0.36} />
              <Stop offset="0.7" stopColor={tone.spot} stopOpacity={0.12} />
              <Stop offset="1" stopColor={tone.spot} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={POOL.rx} cy={POOL.ry} rx={POOL.rx} ry={POOL.ry} fill={`url(#${id}pool)`} />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[
          { position: "absolute", left: middle - SHADOW.rx, top: feet - SHADOW.ry - 1 },
          shadowStyle,
        ]}
      >
        <Svg width={SHADOW.rx * 2} height={SHADOW.ry * 2}>
          <Defs>
            <RadialGradient id={`${id}shadow`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor="#000" stopOpacity={0.42} />
              <Stop offset="0.55" stopColor="#000" stopOpacity={0.18} />
              <Stop offset="1" stopColor="#000" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse
            cx={SHADOW.rx}
            cy={SHADOW.ry}
            rx={SHADOW.rx}
            ry={SHADOW.ry}
            fill={`url(#${id}shadow)`}
          />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}
