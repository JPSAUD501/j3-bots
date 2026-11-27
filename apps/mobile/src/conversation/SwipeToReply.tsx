// SPDX-License-Identifier: AGPL-3.0-or-later
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { Reply } from "lucide-react-native";
import { type ReactNode, useRef } from "react";
import { I18nManager, View } from "react-native";
import { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { useReducedMotion } from "../motion.ts";
import { feelSwipeReply } from "../platform/haptics.ts";
import { AnimatedView } from "./animated.ts";
import { claimsSwipe, REPLY_AT, swipeOffset, swipeProgress } from "./swipe.ts";

const pop = reanimatedSpring(springs.pop);

/** Where the reply mark stands in the room the message leaves as it moves. */
const MARK_AT = 16;

/**
 * A message that a swipe toward the reading direction replies to: it follows
 * the finger, and a reply mark comes up in the room it leaves, fuller as the
 * finger nears where letting go replies, with a light tick as it gets there.
 * Let go there, it replies; anywhere, it springs back on `pop`. A swipe takes
 * only a move that goes mostly across, so the conversation still scrolls and
 * a long press still opens the message's menu. Reduced motion keeps the
 * message in place: the mark alone shows how far along the swipe is, and the
 * reply works the same. Without `onReply` it is the message alone.
 *
 * The finger is followed on the JavaScript thread, the only one a touch
 * reaches without a gesture library, through the view's own touch responder,
 * by writing shared values the UI thread draws from, so nothing is rendered
 * again as it moves.
 */
export function SwipeToReply({
  onReply,
  className,
  children,
}: {
  readonly onReply: (() => void) | null;
  /** The classes of the view that moves, which holds the message. */
  readonly className: string;
  readonly children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  const progress = useSharedValue(0);
  const rtl = I18nManager.isRTL;
  // Where the finger went down, and how far forward it is, while a swipe has the touch.
  const start = useRef({ x: 0, y: 0 });
  const forward = useRef(0);
  const back = () => {
    forward.current = 0;
    if (reduced) {
      offset.set(0);
      progress.set(0);
    } else {
      offset.set(withSpring(0, pop));
      progress.set(withSpring(0, pop));
    }
  };
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  const mark = useAnimatedStyle(() => {
    const along = Math.min(1, Math.max(0, progress.get()));
    return {
      opacity: along,
      transform: [{ scale: reduced ? 1 : 0.5 + 0.5 * along }],
    };
  });
  return (
    <View
      className="self-stretch"
      onTouchStart={({ nativeEvent }) => {
        start.current = { x: nativeEvent.pageX, y: nativeEvent.pageY };
      }}
      onMoveShouldSetResponder={({ nativeEvent }) =>
        onReply !== null &&
        claimsSwipe(nativeEvent.pageX - start.current.x, nativeEvent.pageY - start.current.y, rtl)
      }
      // Granted, the swipe keeps the list from scrolling under it, as a pan responder does.
      onResponderGrant={() => {
        forward.current = 0;
        return true;
      }}
      onResponderMove={({ nativeEvent }) => {
        const before = forward.current;
        const now = (nativeEvent.pageX - start.current.x) * (rtl ? -1 : 1);
        forward.current = now;
        offset.set(reduced ? 0 : (rtl ? -1 : 1) * swipeOffset(now));
        progress.set(swipeProgress(now));
        if (before < REPLY_AT && now >= REPLY_AT) feelSwipeReply();
      }}
      onResponderRelease={() => {
        const replies = forward.current >= REPLY_AT;
        back();
        if (replies) onReply?.();
      }}
      onResponderTerminate={back}
      // Once the swipe has the touch, the list does not take it back to scroll.
      onResponderTerminationRequest={() => false}
    >
      {onReply !== null && (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          className="absolute top-0 bottom-0 justify-center"
          style={{ start: MARK_AT }}
        >
          <AnimatedView
            style={mark}
            className="size-8 items-center justify-center rounded-full bg-muted"
          >
            <Icon icon={Reply} size={18} color="accent-muted-foreground" />
          </AnimatedView>
        </View>
      )}
      <AnimatedView style={moved} className={className}>
        {children}
      </AnimatedView>
    </View>
  );
}
