// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarChoice, BotId } from "@j3-bots/contracts";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { type ComponentRef, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";

/** Where something is drawn, by its centre, and how wide. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** A box from what `measureInWindow` or `measureLayout` reports. */
export const boxFrom = (x: number, y: number, width: number, height: number): Box => ({
  x: x + width / 2,
  y: y + height / 2,
  width,
});

/** How long the bot waits for its conversation's header, at most, before it fades where it is. */
const LANDING_WAIT = 1000;

const slide = reanimatedSpring(springs.slide);

interface Flight {
  readonly botId: BotId;
  readonly look: AvatarChoice;
  /** Where the bot is drawn as it sets off, at its arrival, in the window. */
  readonly from: Box;
  /** Where it lands, once its conversation's header is drawn, in the window. */
  readonly to: Box | null;
}

let flight: Flight | null = null;
const listeners = new Set<() => void>();

const settle = (next: Flight | null) => {
  flight = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const useFlight = () =>
  useSyncExternalStore(
    subscribe,
    () => flight,
    () => null,
  );

/**
 * Sends the first bot from its arrival into its conversation: it is drawn
 * over every screen where it is now, and travels into the conversation's
 * header as soon as that is drawn (`useLandingSpot`). The caller then opens
 * the conversation, which should not slide, so the header holds still.
 */
export function sendOff(botId: BotId, look: AvatarChoice, from: Box): void {
  settle({ botId, look, from, to: null });
}

/** Whether the first bot is on its way to its conversation, so its arrival no longer draws it. */
export const useSentOff = (): boolean => useFlight() !== null;

/**
 * For the avatar in a conversation's header: where it is laid out goes to a
 * bot arriving from the first run, and it stays hidden until the bot lands
 * on it. `onLayout` goes on a view around the avatar.
 */
export function useLandingSpot(botId: BotId | null): {
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly hidden: boolean;
} {
  const now = useFlight();
  const here = now !== null && botId !== null && now.botId === botId ? now : null;
  const onLayout = ({ currentTarget }: LayoutChangeEvent) => {
    // A view is a number only on the old architecture, which the app does not run on.
    if (here === null || typeof currentTarget === "number") return;
    currentTarget.measureInWindow((x, y, width, height) => {
      if (flight !== here) return;
      settle({ ...here, to: boxFrom(x, y, width, height) });
    });
  };
  return { onLayout, hidden: here !== null };
}

/**
 * Draws the first bot in flight, over every screen. Put it once, after the
 * navigation, where it covers the whole window.
 */
export function FlightHost() {
  const now = useFlight();
  const layer = useRef<ComponentRef<typeof View>>(null);
  // Where this layer is in the window. The boxes are measured in the window, which on
  // Android may or may not count the status bar, and this layer is measured the same way.
  const [origin, setOrigin] = useState<Point | null>(null);
  return (
    <View
      ref={layer}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Over the screens while a bot flies, which Android stacks by elevation before order.
      style={[StyleSheet.absoluteFill, { elevation: now === null ? 0 : OVERLAY_ELEVATION }]}
      onLayout={() => layer.current?.measureInWindow((x, y) => setOrigin({ x, y }))}
    >
      {now !== null && origin !== null && <InFlight key={now.botId} flight={now} origin={origin} />}
    </View>
  );
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function InFlight({
  flight: { look, from, to },
  origin,
}: {
  readonly flight: Flight;
  readonly origin: Point;
}) {
  // 0 where it sets off, 1 where it lands; `opacity` fades if it gives up waiting.
  const progress = useSharedValue(0);
  const opacity = useSharedValue(1);
  const target = useSharedValue<Box>(from);
  useEffect(() => {
    if (to === null) {
      const giveUp = setTimeout(() => {
        opacity.set(
          withTiming(0, { duration: motion.state }, (done) => {
            if (done === true) scheduleOnRN(settle, null);
          }),
        );
      }, LANDING_WAIT);
      return () => clearTimeout(giveUp);
    }
    target.set(to);
    progress.set(
      withSpring(1, slide, (done) => {
        if (done === true) scheduleOnRN(settle, null);
      }),
    );
  }, [to, progress, opacity, target]);
  const style = useAnimatedStyle(() => {
    const at = progress.get();
    const end = target.get();
    return {
      opacity: opacity.get(),
      transform: [
        { translateX: (end.x - from.x) * at },
        { translateY: (end.y - from.y) * at },
        { scale: 1 + (end.width / from.width - 1) * at },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: from.x - origin.x - from.width / 2,
          top: from.y - origin.y - from.width / 2,
          width: from.width,
          height: from.width,
        },
        style,
      ]}
    >
      {/* Still: it is in flight for a moment, and its life goes on in the header it lands in. */}
      <BotAvatar avatar={look} seed="first-bot" state="idle" size={from.width} still />
    </Animated.View>
  );
}
