// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import {
  arrivingAt,
  type DrawnRect,
  moveResponse,
  type OtherTag,
  type PageSize,
  pointerAside,
  pointerBounds,
  type PointerMotion,
  pointerThinks,
  restingAt,
  startMove,
  stepPointer,
  tagCloseAfter,
  tagOffset,
  type TagSide,
  tagSide,
} from "@j3-bots/client-runtime/presentation";
import type { Bot, BotId, BrowserTabRef } from "@j3-bots/contracts";
import {
  easeOutCurve,
  motion as durations,
  pointer,
  press,
  reanimatedSpring,
  springs,
} from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import Svg, { Path } from "react-native-svg";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { useBotInk } from "../conversation/tint.ts";
import { useReducedMotion } from "../motion.ts";

const easeOut = Easing.bezier(...easeOutCurve);
const pop = reanimatedSpring(springs.pop);
const slide = reanimatedSpring(springs.slide);
/** A tag's width before it is measured, in px. */
const TAG_WIDTH_GUESS = 80;
/** The longest a frame counts for, in seconds: a pointer whose callback was off sets off from rest. */
const LONGEST_FRAME = 0.1;

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

/** Where a bot's tag sits since its last point, and whether it is drawn over the others. */
interface Placed {
  readonly cursor: BrowserCursor;
  readonly side: TagSide;
  readonly layer: number;
}

/**
 * Each bot's pointer over the page, the way documents written by several
 * hands show who is where, drawn as the web draws it (`BotCursor.tsx`) and
 * moving on the same core (`pointerMotion` in the client runtime): a rounded
 * arrow in the bot's color that leans into a move on its tip, and a tag with
 * its face and name while it moves, clicks or answers the person, on the
 * side clear of the page's edges and of the other bots' tags. While the
 * person holds the tab (`held`) the pointers move aside, faded, their tags
 * open. Only bots on the tab show. A pointer comes in from behind its arrow
 * where it first points; one from another tab, or from before the page went
 * to `address`, waits to show again where it next points.
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
  // The click each bot's pointer last answered, so a pointer that shows again does not answer it twice.
  const [answered, setAnswered] = useState<ReadonlyMap<BotId, number>>(new Map());
  const [tagWidths, setTagWidths] = useState<ReadonlyMap<BotId, number>>(new Map());

  // Each new point places its bot's tag clear of the others' as they stand, and draws it on top.
  const [placed, setPlaced] = useState<ReadonlyMap<BotId, Placed>>(new Map());
  const live = new Map<BotId, BrowserCursor>();
  for (const botId of onIt) {
    const cursor = cursors.get(botId);
    if (cursor !== undefined && cursor !== since.stale.get(botId)) live.set(botId, cursor);
  }
  const moved = [...live].filter(([botId, cursor]) => placed.get(botId)?.cursor !== cursor);
  if (moved.length > 0 && page.width > 0 && page.height > 0) {
    const next = new Map(placed);
    const scale = { x: drawn.width / page.width, y: drawn.height / page.height };
    const inDrawing = (cursor: BrowserCursor) => ({ x: cursor.x * scale.x, y: cursor.y * scale.y });
    let layer = Math.max(0, ...[...placed.values()].map((one) => one.layer));
    for (const [botId, cursor] of moved) {
      const others: Array<OtherTag> = [];
      for (const [id, one] of next) {
        if (id === botId || !live.has(id)) continue;
        others.push({
          at: inDrawing(one.cursor),
          width: tagWidths.get(id) ?? TAG_WIDTH_GUESS,
          side: one.side,
        });
      }
      const width = tagWidths.get(botId) ?? TAG_WIDTH_GUESS;
      layer += 1;
      next.set(botId, {
        cursor,
        side: tagSide(inDrawing(cursor), width, drawn, others),
        layer,
      });
    }
    setPlaced(next);
  }

  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {onIt.flatMap((botId) => {
        const cursor = live.get(botId);
        const bot = bots.get(botId);
        const shown = placed.get(botId);
        if (
          cursor === undefined ||
          bot === undefined ||
          shown === undefined ||
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
            side={shown.side}
            layer={shown.layer}
            held={held}
            thinking={!held && pointerThinks(bot.state)}
            answered={answered.get(botId) ?? null}
            onAnswered={(click) => setAnswered((now) => new Map(now).set(botId, click))}
            onTagWidth={(width) =>
              setTagWidths((now) =>
                now.get(botId) === width ? now : new Map(now).set(botId, width),
              )
            }
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
  side,
  layer,
  held,
  thinking,
  answered,
  onAnswered,
  onTagWidth,
}: {
  readonly bot: Bot;
  readonly cursor: BrowserCursor;
  readonly page: PageSize;
  readonly drawn: DrawnRect;
  readonly side: TagSide;
  readonly layer: number;
  readonly held: boolean;
  readonly thinking: boolean;
  /** The sequence of the bot's click this pointer last answered, null before any. */
  readonly answered: number | null;
  readonly onAnswered: (click: number) => void;
  readonly onTagWidth: (width: number) => void;
}) {
  const ink = useBotInk(bot.profile.avatar);
  const reduced = useReducedMotion();
  const face = useRef<AvatarHandle>(null);

  // The motion, in the page's px, stepped on the UI thread by one frame callback while anything
  // of it moves. Each thing that starts it again is a new `version`: the callback says which one
  // it arrived or came to rest on, and an answer about an older one is let go.
  const motion = useSharedValue<PointerMotion | null>(null);
  const thinks = useSharedValue(thinking);
  const version = useSharedValue(0);
  const restedOn = useSharedValue(-1);
  const latest = useRef(0);
  /** The click to play when the pointer arrives; a newer point drops it. */
  const pending = useRef<number | null>(null);
  const squash = useSharedValue(1);
  const ring = useSharedValue(1);

  // The tag opens on each point and as the person takes the tab, and closes on a timer after.
  const [tagged, setTagged] = useState(true);
  const [taggedFor, setTaggedFor] = useState({ cursor, held });
  if (taggedFor.cursor !== cursor || taggedFor.held !== held) {
    setTaggedFor({ cursor, held });
    if (taggedFor.cursor !== cursor || held) setTagged(true);
  }
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTagIn = (ms: number) => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setTagged(false), ms);
  };
  useEffect(() => () => clearTimeout(closing.current), []);

  // The pointer lands: a click to answer plays there, and the tag closes a moment after.
  const arrived = useEffectEvent((on: number) => {
    if (on !== latest.current) return;
    const click = pending.current;
    pending.current = null;
    if (click !== null) {
      // The arrow goes down from its tip and springs back, a ring spreads, the face smiles.
      onAnswered(click);
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
    if (!held) closeTagIn(tagCloseAfter(click === null ? "move" : "click"));
  });
  // What turns the frame callback off, once it exists: it is told it rested from the UI thread.
  const stopFrames = useRef<() => void>(() => {});
  const rested = useEffectEvent((on: number) => {
    if (on === latest.current) stopFrames.current();
  });
  const frames = useFrameCallback((info) => {
    "worklet";
    const now = motion.get();
    if (now === null || restedOn.get() === version.get()) return;
    const seconds = Math.min(LONGEST_FRAME, (info.timeSincePreviousFrame ?? 16) / 1000);
    const step = stepPointer(now, seconds, {
      thinking: thinks.get(),
      driftBudget: Number.POSITIVE_INFINITY,
      lean: true,
      reduced: false,
    });
    motion.set(step.motion);
    if (step.arrived) scheduleOnRN(arrived, version.get());
    if (step.resting) {
      restedOn.set(version.get());
      scheduleOnRN(rested, version.get());
    }
  }, false);
  useEffect(() => {
    stopFrames.current = () => frames.setActive(false);
  }, [frames]);

  /** Puts the frame callback to work again, on what the motion is now. */
  const wake = () => {
    latest.current += 1;
    version.set(latest.current);
    frames.setActive(true);
  };
  /** Moves on from `next`: on the UI thread, or at once under reduced motion. */
  const go = (next: PointerMotion) => {
    if (reduced) {
      latest.current += 1;
      const step = stepPointer(next, Number.POSITIVE_INFINITY, {
        thinking: false,
        driftBudget: 0,
        lean: false,
        reduced: true,
      });
      motion.set(step.motion);
      if (step.arrived) arrived(latest.current);
      return;
    }
    motion.set(next);
    wake();
  };

  // Each point: from where it is on its path, mid-move too, or in from behind its arrow where it first points.
  const pointed = useEffectEvent((to: BrowserCursor) => {
    const at = { x: to.x, y: to.y };
    const bounds = pointerBounds(page);
    const now = motion.get();
    pending.current = to.action === "click" && to.sequence !== answered ? to.sequence : null;
    clearTimeout(closing.current);
    if (now === null) {
      go(reduced ? startMove(restingAt(at), at, 0, bounds) : arrivingAt(at, bounds));
      return;
    }
    const share =
      Math.hypot(at.x - now.x, at.y - now.y) / Math.max(1, Math.hypot(page.width, page.height));
    go(startMove(now, at, moveResponse(share), bounds));
  });
  useEffect(() => pointed(cursor), [cursor]);

  // Thinking before it acts: the tip drifts in a small figure eight, upright.
  const thought = useEffectEvent((now: boolean) => {
    thinks.set(now);
    if (motion.get() !== null && !reduced) wake();
  });
  useEffect(() => thought(thinking), [thinking]);

  // The person takes the tab: it moves aside and fades, surprised a moment, then waiting until it
  // is given back, when it fades back where it waited and goes on from there.
  const [waits, setWaits] = useState(false);
  if (!held && waits) setWaits(false);
  const wasHeld = useRef(held);
  const holding = useEffectEvent((now: boolean) => {
    if (now === wasHeld.current) return;
    wasHeld.current = now;
    if (!now) {
      closeTagIn(pointer.tagLinger);
      return;
    }
    face.current?.poke("hover");
    clearTimeout(closing.current);
    const current = motion.get();
    if (current === null) return;
    const target = current.moving
      ? { x: current.path.x1, y: current.path.y1 }
      : { x: current.x, y: current.y };
    const aside = pointerAside({ x: target.x / page.width, y: target.y / page.height });
    pending.current = null;
    go(
      startMove(
        current,
        { x: target.x + aside.x, y: target.y + aside.y },
        pointer.asideResponse,
        pointerBounds(page),
      ),
    );
  });
  useEffect(() => {
    holding(held);
    if (!held) return;
    const timer = setTimeout(() => setWaits(true), pointer.surprise);
    return () => clearTimeout(timer);
  }, [held]);

  // In the page's px, mapped to where the picture is drawn, so zooming and panning move it at once.
  const placedStyle = useAnimatedStyle(() => {
    const now = motion.get();
    const x = now === null ? 0 : now.tipX / page.width;
    const y = now === null ? 0 : now.tipY / page.height;
    return {
      left: drawn.left + x * drawn.width,
      top: drawn.top + y * drawn.height,
      opacity: withTiming(held ? pointer.heldOpacity : 1, { duration: durations.state }),
    };
  });
  // The arrow turns and presses on its tip, which stays on the point; the tag and the ring never turn.
  const arrowStyle = useAnimatedStyle(() => ({
    transformOrigin: [0, 0, 0],
    transform: [{ rotate: `${motion.get()?.lean ?? 0}deg` }, { scale: squash.get() }],
  }));
  const ringing = useAnimatedStyle(() => ({
    opacity: 1 - ring.get(),
    transform: [{ scale: reduced ? 1 : interpolate(ring.get(), [0, 1], [0.3, pointer.ringTo]) }],
  }));
  const blooming = useAnimatedStyle(() => ({
    opacity: pointer.bloomOpacity * (1 - ring.get()),
    transform: [{ scale: reduced ? 1 : interpolate(ring.get(), [0, 1], [0.6, 1.4]) }],
  }));

  const [tagWidth, setTagWidth] = useState(TAG_WIDTH_GUESS);
  const offset = tagOffset(side, tagWidth);
  const open = tagged || held;
  const tagStyle = useAnimatedStyle(() => ({
    opacity: withTiming(open ? 1 : 0, { duration: durations.state }),
    transform: [
      { translateX: reduced ? offset.x : withSpring(offset.x, slide) },
      { translateY: reduced ? offset.y : withSpring(offset.y, slide) },
      { scale: reduced ? 1 : withSpring(open ? 1 : pointer.tagFrom, pop) },
    ],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(durations.state)}
      style={[{ position: "absolute", zIndex: layer }, placedStyle]}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            left: -5,
            top: -5,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: ink,
          },
          blooming,
        ]}
      />
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
      <Animated.View style={arrowStyle}>
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
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          setTagWidth(width);
          onTagWidth(width);
        }}
        style={[
          {
            left: 0,
            top: 0,
            height: pointer.tagHeight,
            backgroundColor: pointer.light,
            borderWidth: pointer.tagEdge,
            borderColor: ink,
            boxShadow: pointer.tagShadow,
            transformOrigin: `${side.x > 0 ? "left" : "right"} ${side.y > 0 ? "top" : "bottom"}`,
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
        />
        <Text numberOfLines={1} className="text-2xs font-semibold" style={{ color: pointer.ink }}>
          {bot.profile.name}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
