// SPDX-License-Identifier: AGPL-3.0-or-later
import { avatarAppearance } from "@j3-bots/client-runtime/presentation";
import type { Avatar, BotState } from "@j3-bots/contracts";
import {
  type AvatarBadgeName,
  avatarMarks,
  avatarMarkStroke,
  type AvatarMarkName,
  type AvatarMarkPart,
  avatarProportions,
  avatarShapeCutout,
  avatarShapes,
  type BotColor,
  motion,
  resolveAvatar,
  roomAvatarShare,
} from "@j3-bots/design-tokens";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { useReducedMotion, useStep } from "../motion.ts";
import { useColor } from "../theme.ts";

// Each class written out, so Tailwind generates it.
const shapeColor = {
  red: "accent-bot-red",
  orange: "accent-bot-orange",
  yellow: "accent-bot-yellow",
  green: "accent-bot-green",
  teal: "accent-bot-teal",
  blue: "accent-bot-blue",
  indigo: "accent-bot-indigo",
  violet: "accent-bot-violet",
  pink: "accent-bot-pink",
  gray: "accent-bot-gray",
} as const satisfies Record<BotColor, string>;

const badgeColor = {
  waiting: "accent-waiting",
  blocked: "accent-blocked",
  unread: "accent-accent",
} as const satisfies Record<AvatarBadgeName, string>;

/** What an avatar sits on, which its badge and a room's overlapping shapes are cut out of. */
export type AvatarGround = "background" | "surface" | "muted";

const groundColor = {
  background: "accent-background",
  surface: "accent-surface",
  muted: "accent-muted",
} as const satisfies Record<AvatarGround, string>;

const BOX = "0 0 100 100";
const ease = Easing.bezier(0.2, 0, 0, 1);
const { breathePeriod, breatheSteps, spinPeriod, spinSteps } = motion.avatar;

/** The breathing ring's scale at `step`: from 0.72 up to full size and back, over a period. */
const breatheScale = (step: number) => 0.72 + 0.28 * (1 - Math.abs((2 * step) / breatheSteps - 1));

/**
 * The one-time animations of a change of mark: the shape nudges and the new
 * mark eases in. Nothing plays for the mark an avatar mounts with, nor with
 * reduced motion.
 */
function useMarkChange(mark: AvatarMarkName, reduced: boolean) {
  const [nudge] = useState(() => new Animated.Value(1));
  const [markIn] = useState(() => new Animated.Value(1));
  const [markScale] = useState(() => Animated.add(0.5, Animated.multiply(markIn, 0.5)));
  const shown = useRef(mark);
  useEffect(() => {
    if (shown.current === mark) return;
    shown.current = mark;
    if (reduced) return;
    nudge.setValue(1);
    markIn.setValue(0);
    const animation = Animated.parallel([
      Animated.sequence([
        Animated.timing(nudge, {
          toValue: 1.08,
          duration: motion.slow / 2,
          easing: ease,
          useNativeDriver: true,
        }),
        Animated.timing(nudge, {
          toValue: 1,
          duration: motion.slow / 2,
          easing: ease,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(markIn, {
        toValue: 1,
        duration: motion.state,
        easing: ease,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [mark, reduced, nudge, markIn]);
  return {
    shape: { transform: [{ scale: nudge }] },
    mark: {
      opacity: markIn,
      transform: [{ scale: markScale }],
    },
  };
}

/**
 * A bot's face: its shape filled with its color, one mark inside that changes
 * with the state, and a corner badge when the state concerns the operator.
 * Thinking breathes and working turns, in steps; reduced motion keeps the
 * mark's still form. Without `label` it is hidden from screen readers, for
 * places where text beside it says the same.
 */
export function BotAvatar({
  avatar,
  state,
  unread = false,
  size,
  ground = "background",
  label,
}: {
  readonly avatar: Avatar;
  readonly state: BotState;
  /** Whether the bot said something the operator has not read; an idle bot then shows as done. */
  readonly unread?: boolean;
  /** In px: 28 in a header, 36 in the roster. */
  readonly size: number;
  readonly ground?: AvatarGround;
  readonly label?: string;
}) {
  const { shape: shapeName, color } = resolveAvatar(avatar);
  const shape = avatarShapes[shapeName];
  const look = avatarAppearance(state, unread);
  const { markScale, badge } = avatarProportions(size);
  const reduced = useReducedMotion();
  const fill = useColor(shapeColor[color]);
  const ink = useColor("accent-avatar-ink");
  const breathing = useStep(breathePeriod, breatheSteps, look.motion === "breathe" && !reduced);
  const turning = useStep(spinPeriod, spinSteps, look.motion === "spin" && !reduced);
  const moving =
    reduced || look.motion === "none"
      ? ""
      : look.motion === "breathe"
        ? ` scale(${breatheScale(breathing)})`
        : ` rotate(${(turning * 360) / spinSteps})`;
  const change = useMarkChange(look.mark, reduced);
  // The mark eases in about its own point, which is the shape's visual center.
  const origin = `${(shape.mark.x / 100) * size}px ${(shape.mark.y / 100) * size}px`;
  const layer = { position: "absolute", width: size, height: size } as const;
  return (
    <View
      style={{ width: size, height: size }}
      {...(label === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" }
        : { accessible: true, accessibilityRole: "image", accessibilityLabel: label })}
    >
      <Animated.View style={[layer, change.shape]}>
        <Svg width={size} height={size} viewBox={BOX}>
          <Path d={shape.path} fill={fill} />
        </Svg>
      </Animated.View>
      <Animated.View style={[layer, { transformOrigin: origin }, change.mark]}>
        <Svg width={size} height={size} viewBox={BOX}>
          <G transform={`translate(${shape.mark.x} ${shape.mark.y}) scale(${markScale})${moving}`}>
            {avatarMarks[look.mark].map((part: AvatarMarkPart, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- parts are positional: a mark's data never reorders
              <MarkPart key={index} part={part} ink={ink} />
            ))}
          </G>
        </Svg>
      </Animated.View>
      {look.badge !== null && (
        <Badge name={look.badge} size={size} proportions={badge} ground={ground} />
      )}
    </View>
  );
}

/** The corner badge, cut out of what the avatar sits on. */
function Badge({
  name,
  size,
  proportions,
  ground,
}: {
  readonly name: AvatarBadgeName;
  readonly size: number;
  readonly proportions: ReturnType<typeof avatarProportions>["badge"];
  readonly ground: AvatarGround;
}) {
  const fill = useColor(badgeColor[name]);
  const cutout = useColor(groundColor[ground]);
  return (
    <Svg width={size} height={size} viewBox={BOX} style={{ position: "absolute" }}>
      <Circle
        cx={proportions.center}
        cy={proportions.center}
        r={proportions.r}
        fill={fill}
        stroke={cutout}
        strokeWidth={proportions.cutout}
      />
    </Svg>
  );
}

function MarkPart({ part, ink }: { readonly part: AvatarMarkPart; readonly ink: string }) {
  const outline = {
    fill: "none",
    stroke: ink,
    strokeWidth: avatarMarkStroke,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (part.kind) {
    case "disc":
      return <Circle r={part.r} fill={ink} />;
    case "circle":
      return (
        <Circle
          r={part.r}
          {...outline}
          {...(part.opacity === undefined ? {} : { strokeOpacity: part.opacity })}
          {...(part.dash === undefined ? {} : { strokeDasharray: [...part.dash] })}
        />
      );
    case "path":
      return <Path d={part.d} {...outline} />;
  }
}

/**
 * A silhouette alone, cut out of what it sits on: who, without a state, as
 * beside a room message's speaker or in a room's avatar.
 */
export function AvatarShape({
  avatar,
  size,
  ground = "background",
}: {
  readonly avatar: Avatar;
  readonly size: number;
  readonly ground?: AvatarGround;
}) {
  const { shape, color } = resolveAvatar(avatar);
  const fill = useColor(shapeColor[color]);
  const cutout = useColor(groundColor[ground]);
  const d = avatarShapes[shape].path;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={BOX}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* The outline goes under the fill, so only its outer half shows, cutting the shape free. */}
      <Path d={d} fill="none" stroke={cutout} strokeWidth={avatarShapeCutout} />
      <Path d={d} fill={fill} />
    </Svg>
  );
}

/** Two members' shapes overlapping: a room. */
export function RoomAvatar({
  members,
  size,
  ground = "background",
}: {
  readonly members: ReadonlyArray<Avatar>;
  readonly size: number;
  readonly ground?: AvatarGround;
}) {
  const [back, front] = members;
  const part = Math.round(size * roomAvatarShare);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {back !== undefined && (
        <View style={{ position: "absolute", top: 0, left: 0 }}>
          <AvatarShape avatar={back} size={part} ground={ground} />
        </View>
      )}
      {front !== undefined && (
        <View style={{ position: "absolute", right: 0, bottom: 0 }}>
          <AvatarShape avatar={front} size={part} ground={ground} />
        </View>
      )}
    </View>
  );
}
