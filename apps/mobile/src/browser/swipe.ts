// SPDX-License-Identifier: AGPL-3.0-or-later
import { claimsSwipe, swipeDirection } from "@j3-bots/client-runtime/presentation";
import { useRef } from "react";
import { type GestureResponderEvent, I18nManager, type ViewProps } from "react-native";

type Responder = Pick<
  ViewProps,
  | "onStartShouldSetResponderCapture"
  | "onMoveShouldSetResponderCapture"
  | "onResponderMove"
  | "onResponderRelease"
  | "onResponderTerminate"
  | "onResponderTerminationRequest"
>;

/** Where a touch started and when. */
interface Start {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

const startOf = ({ nativeEvent }: GestureResponderEvent): Start => ({
  x: nativeEvent.pageX,
  y: nativeEvent.pageY,
  at: nativeEvent.timestamp,
});

/**
 * A sideways swipe over a view, which the buttons in it keep their presses
 * through: it is taken only once the finger has gone clearly sideways.
 * `onMove` follows the finger; `onSwipe` says which way a swipe went (1
 * toward the end, the finger going toward the start: right to left, but for
 * a language written right to left) or null when it fell short.
 */
export function useSideSwipe(handlers: {
  readonly onSwipe: (direction: -1 | 1 | null) => void;
  readonly onMove?: (dx: number) => void;
}): Responder {
  const start = useRef<Start | null>(null);
  const moved = (event: GestureResponderEvent) => {
    const from = start.current;
    const now = startOf(event);
    return from === null
      ? { dx: 0, dy: 0, ms: 0 }
      : { dx: now.x - from.x, dy: now.y - from.y, ms: Math.max(now.at - from.at, 1) };
  };
  return {
    // Every touch passes here first; it is only noted, and the views under it keep it.
    onStartShouldSetResponderCapture: (event) => {
      start.current = startOf(event);
      return false;
    },
    onMoveShouldSetResponderCapture: (event) => {
      const { dx, dy } = moved(event);
      return claimsSwipe(dx, dy);
    },
    onResponderTerminationRequest: () => false,
    onResponderMove: (event) => handlers.onMove?.(moved(event).dx),
    onResponderRelease: (event) => {
      const { dx, ms } = moved(event);
      handlers.onSwipe(swipeDirection(dx, ms, I18nManager.isRTL));
    },
    onResponderTerminate: () => handlers.onSwipe(null),
  };
}
