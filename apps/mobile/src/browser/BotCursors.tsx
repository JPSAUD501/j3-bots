// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import {
  alongGlide,
  type DrawnRect,
  glideBend,
  type GlideSide,
  type PageSize,
  pointerAside,
  pointerThinks,
  tagOpenFor,
} from "@j3-bots/client-runtime/presentation";
import type { Bot, BotId, BrowserTabRef } from "@j3-bots/contracts";
import {
  easeOutCurve,
  glideCurve,
  glideFor,
  motion,
  pointer,
  press,
  reanimatedSpring,
  springs,
} from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { useBotInk } from "../conversation/tint.ts";
import { useReducedMotion } from "../motion.ts";

const glideEase = Easing.bezier(...glideCurve);
const easeOut = Easing.bezier(...easeOutCurve);
const pop = reanimatedSpring(springs.pop);

/** Each bot's newest pointer on the tab, by bot. */
export type Cursors = ReadonlyMap<BotId, BrowserCursor>;

/**
 * Adds `cursor` to `cursors`. A pointer from a server before shared tabs
 * names no bot: it is the tab's one bot's.
 */
export const withCursor = (
  cursors: Cursors,
  cursor: BrowserCursor,
  onIt: ReadonlyArray<BotId>,
): Cursors => {
  const botId = cursor.botId ?? onIt[0];
  if (botId === undefined) return cursors;
  return new Map(cursors).set(botId, cursor);
};

/**
 * Each bot's pointer over the page, the way documents written by several
 * hands show who is where, drawn as the web draws it (`BotCursor.tsx`): a
 * rounded arrow in the bot's color that never turns, and a tag with its face
 * and name while it moves, clicks or answers the person. While the person
 * holds the tab (`held`) the pointers step aside, faded, their tags open.
 * Only bots on the tab show. A pointer fades in where it first points; one
 * from another tab, or from before the page went to `address`, waits to show
 * again where it next points.
 */
export function BotCursors({
  cursors,
  tab,
  address,
  onIt,
  drawn,
  page,
  held,
}: {
  readonly cursors: Cursors;
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly onIt: ReadonlyArray<BotId>;
  readonly drawn: DrawnRect;
  readonly page: PageSize;
  readonly held: boolean;
}) {
  const bots = useBots();
  // The pointers there were as the tab or its page last changed, which no longer say where the bots are.
  const place = `${tab} ${address}`;
  const [since, setSince] = useState<{ readonly place: string; readonly stale: Cursors }>({
    place,
    stale: new Map(),
  });
  if (since.place !== place) setSince({ place, stale: cursors });
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {onIt.flatMap((botId) => {
        const cursor = cursors.get(botId);
        const bot = bots.get(botId);
        if (
          cursor === undefined ||
          cursor === since.stale.get(botId) ||
          bot === undefined ||
          page.width <= 0 ||
          page.height <= 0
        ) {
          return [];
        }
        return [
          <Pointer
            key={botId}
            bot={bot}
            cursor={cursor}
            page={page}
            drawn={drawn}
            held={held}
            thinking={!held && pointerThinks(bot.state)}
          />,
        ];
      })}
    </View>
  );
}

function Pointer({
  bot,
  cursor,
  page,
  drawn,
  held,
  thinking,
}: {
  readonly bot: Bot;
  readonly cursor: BrowserCursor;
  readonly page: PageSize;
  readonly drawn: DrawnRect;
  readonly held: boolean;
  readonly thinking: boolean;
}) {
  const ink = useBotInk(bot.profile.avatar);
  const reduced = useReducedMotion();
  const face = useRef<AvatarHandle>(null);
  const at = { x: cursor.x / page.width, y: cursor.y / page.height };

  // The tag shows from each move or click until a moment after the pointer stops.
  const [seen, setSeen] = useState(cursor.sequence);
  const [tagged, setTagged] = useState(true);
  if (seen !== cursor.sequence) {
    setSeen(cursor.sequence);
    setTagged(true);
  }

  // The glide, as shares of the page, so zooming and panning the page move it at once: from where
  // it is, mid-glide too, on a gentle curve to where it points, each curve bending to the other side.
  const fromX = useSharedValue(at.x);
  const fromY = useSharedValue(at.y);
  const bendX = useSharedValue(at.x);
  const bendY = useSharedValue(at.y);
  const toX = useSharedValue(at.x);
  const toY = useSharedValue(at.y);
  const along = useSharedValue(1);
  const side = useRef<GlideSide>(1);
  const squash = useSharedValue(1);
  const ring = useSharedValue(1);
  const moved = useEffectEvent((to: BrowserCursor) => {
    const target = { x: to.x / page.width, y: to.y / page.height };
    const here = alongGlide(
      { x: fromX.get(), y: fromY.get() },
      { x: bendX.get(), y: bendY.get() },
      { x: toX.get(), y: toY.get() },
      along.get(),
    );
    const start = { x: here.x * page.width, y: here.y * page.height };
    const end = { x: to.x, y: to.y };
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const glide =
      reduced || length === 0 ? 0 : glideFor(length / Math.hypot(page.width, page.height));
    cancelAnimation(along);
    if (glide === 0) {
      fromX.set(target.x);
      fromY.set(target.y);
      bendX.set(target.x);
      bendY.set(target.y);
      along.set(1);
    } else {
      side.current = side.current === 1 ? -1 : 1;
      const bend = glideBend(start, end, side.current);
      fromX.set(here.x);
      fromY.set(here.y);
      bendX.set(bend.x / page.width);
      bendY.set(bend.y / page.height);
      along.set(0);
      along.set(withTiming(1, { duration: glide, easing: glideEase }));
    }
    toX.set(target.x);
    toY.set(target.y);
    if (to.action === "click") {
      // The arrow goes down from its point and springs back, a ring spreads, the face smiles.
      face.current?.poke("smile");
      ring.set(0);
      ring.set(withTiming(1, { duration: pointer.ring, easing: easeOut }));
      if (!reduced) {
        squash.set(
          withSequence(
            withTiming(pointer.pressScale, { duration: press.duration, easing: easeOut }),
            withSpring(1, pop),
          ),
        );
      }
    }
    const timer = setTimeout(() => setTagged(false), tagOpenFor(to.action, glide));
    return () => clearTimeout(timer);
  });
  useEffect(() => moved(cursor), [cursor]);
  const placed = useAnimatedStyle(() => {
    const point = alongGlide(
      { x: fromX.get(), y: fromY.get() },
      { x: bendX.get(), y: bendY.get() },
      { x: toX.get(), y: toY.get() },
      along.get(),
    );
    return {
      left: drawn.left + point.x * drawn.width,
      top: drawn.top + point.y * drawn.height,
    };
  });

  // Thinking before it acts: a small bob up and back.
  const bob = useSharedValue(0);
  useEffect(() => {
    if (!thinking || reduced) {
      cancelAnimation(bob);
      bob.set(0);
      return;
    }
    const half = { duration: pointer.bobPeriod / 2, easing: Easing.inOut(Easing.ease) };
    bob.set(withRepeat(withSequence(withTiming(-pointer.bob, half), withTiming(0, half)), -1));
  }, [thinking, reduced, bob]);
  const bobbing = useAnimatedStyle(() => ({ transform: [{ translateY: bob.get() }] }));
  const pressed = useAnimatedStyle(() => ({
    transformOrigin: [0, 0, 0],
    transform: [{ scale: squash.get() }],
  }));
  const ringing = useAnimatedStyle(() => ({
    opacity: 1 - ring.get(),
    transform: [{ scale: reduced ? 1 : interpolate(ring.get(), [0, 1], [0.3, 1.6]) }],
  }));

  // The person takes the tab: it steps aside and fades, surprised a moment, then waiting until it is given back.
  const [waits, setWaits] = useState(false);
  if (!held && waits) setWaits(false);
  useEffect(() => {
    if (!held) return;
    face.current?.poke("hover");
    const timer = setTimeout(() => setWaits(true), pointer.surprise);
    return () => clearTimeout(timer);
  }, [held]);
  const aside = held ? pointerAside(at) : { x: 0, y: 0 };
  const step = { duration: reduced ? 0 : motion.glide, easing: glideEase };
  const stepped = useAnimatedStyle(() => ({
    opacity: withTiming(held ? pointer.heldOpacity : 1, { duration: motion.state }),
    transform: [
      { translateX: withTiming(aside.x, step) },
      { translateY: withTiming(aside.y, step) },
    ],
  }));

  const open = tagged || held;
  const tagStyle = useAnimatedStyle(() => ({
    opacity: withTiming(open ? 1 : 0, { duration: motion.state }),
    transformOrigin: [0, 0, 0],
    transform: [{ scale: reduced ? 1 : withSpring(open ? 1 : pointer.tagFrom, pop) }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(motion.state)}
      style={[{ position: "absolute" }, placed]}
    >
      <Animated.View style={stepped}>
        <Animated.View style={bobbing}>
          <Animated.View
            style={[
              {
                position: "absolute",
                left: -12,
                top: -12,
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: ink,
              },
              ringing,
            ]}
          />
          <Animated.View style={pressed}>
            <View
              style={{
                position: "absolute",
                left: -pointer.tip.x,
                top: -pointer.tip.y,
                filter: pointer.arrowShadow,
              }}
            >
              <Svg
                width={pointer.box}
                height={pointer.box}
                viewBox={`0 0 ${pointer.box} ${pointer.box}`}
              >
                <Path
                  d={pointer.arrow}
                  fill={ink}
                  stroke={pointer.light}
                  strokeWidth={pointer.outline}
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
          </Animated.View>
          <Animated.View
            className="absolute flex-row items-center gap-1 rounded-pill ps-0.5 pe-2"
            style={[
              {
                left: pointer.tagAt.x,
                top: pointer.tagAt.y,
                height: pointer.tagHeight,
                backgroundColor: pointer.light,
                borderWidth: pointer.tagEdge,
                borderColor: ink,
                boxShadow: pointer.tagShadow,
              },
              tagStyle,
            ]}
          >
            <BotAvatar
              ref={face}
              avatar={bot.profile.avatar}
              seed={bot.id}
              state={held && waits ? "waiting" : "idle"}
              size={pointer.face}
              still={!open}
            />
            <Text
              numberOfLines={1}
              className="text-2xs font-semibold"
              style={{ color: pointer.ink }}
            >
              {bot.profile.name}
            </Text>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
