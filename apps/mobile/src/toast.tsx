// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { AccessibilityInfo } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { Text } from "./text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const pop = reanimatedSpring(springs.pop);

/** How long a toast stays: long enough to read twice. */
const SHOWN_FOR = 6000;

const SayContext = createContext<((text: string) => void) | null>(null);

/**
 * A short sentence about something that just happened out of view, such as a
 * change this device could not keep. It goes by itself and asks nothing:
 * what the operator can act on stays where they act. Screen readers hear it
 * once, as it comes.
 */
export function Toasts({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const next = useRef(0);
  const say = useCallback((text: string) => {
    next.current += 1;
    setShown({ id: next.current, text });
    AccessibilityInfo.announceForAccessibility(text);
  }, []);
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), SHOWN_FOR);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <SayContext value={say}>
      {children}
      {shown !== null && (
        <Animated.View
          key={shown.id}
          entering={FadeInUp.springify()
            .mass(pop.mass)
            .stiffness(pop.stiffness)
            .damping(pop.damping)}
          exiting={FadeOutUp.duration(motion.state)}
          pointerEvents="none"
          className="absolute inset-x-4 items-center"
          // At the top, clear of the composer and the keyboard at the bottom.
          style={{ top: insets.top + 8 }}
          // Announced as it came; the visible copy is not read again.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text
            className="max-w-sm rounded-lg bg-foreground px-4 py-2.5 text-sm text-background"
            style={{ elevation: 6 }}
          >
            {shown.text}
          </Text>
        </Animated.View>
      )}
    </SayContext>
  );
}

/** Shows a toast. */
export const useSay = (): ((text: string) => void) => {
  const say = use(SayContext);
  if (say === null) throw new Error("useSay needs Toasts above it.");
  return say;
};
