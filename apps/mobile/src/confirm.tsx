// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Modal, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { useReducedMotion } from "./motion.ts";
import { Text, displaySpacing } from "./text.tsx";
import { OVERLAY_ELEVATION } from "./theme.ts";
import { Button } from "./ui.tsx";

/** What a confirmation asks: what goes and what stays, and the two answers. */
export interface Question {
  readonly title: string;
  readonly body: string;
  /** The answer that keeps things as they are, which has the focus. */
  readonly cancel: string;
  /** The answer that acts, which cannot be undone. */
  readonly confirm: string;
  readonly onConfirm: () => void;
}

const AskContext = createContext<((question: Question) => void) | null>(null);

const pop = reanimatedSpring(springs.pop);

/**
 * Asks before something that cannot be undone, in the app's own short dialog
 * rather than the system's alert, so it reads and moves like every other
 * surface: a `surface` panel over the scrim that pops in from slightly
 * smaller on `pop` and leaves on `out`. The answer that keeps things as they
 * are has the focus; Back or a tap outside gives that answer too.
 */
export function Confirmations({ children }: { readonly children: ReactNode }) {
  const [asked, setAsked] = useState<Question | null>(null);
  const reduced = useReducedMotion();
  // The modal stays up while the panel leaves, then goes, on a timer rather
  // than the animation's own end, as the New menu does, so a modal with
  // nothing left in it never stays over the app taking its touches.
  const [held, setHeld] = useState(asked);
  if (asked !== null && asked !== held) setHeld(asked);
  useEffect(() => {
    if (asked !== null || held === null) return;
    const timer = setTimeout(() => setHeld(null), reduced ? 0 : motion.state);
    return () => clearTimeout(timer);
  }, [asked, held, reduced]);
  const keep = useRef<ComponentRef<typeof View>>(null);
  const close = () => setAsked(null);
  return (
    <AskContext value={setAsked}>
      {children}
      <Modal
        visible={held !== null}
        transparent
        statusBarTranslucent
        animationType="none"
        onRequestClose={close}
        onShow={() => {
          if (keep.current !== null)
            AccessibilityInfo.sendAccessibilityEvent(keep.current, "focus");
        }}
      >
        {asked !== null && (
          <View className="flex-1 items-center justify-center px-6">
            <Animated.View
              entering={FadeIn.duration(motion.slow)}
              exiting={FadeOut.duration(motion.state)}
              className="absolute inset-0 bg-scrim"
            >
              <Pressable
                accessible={false}
                importantForAccessibility="no"
                onPress={close}
                className="flex-1"
              />
            </Animated.View>
            <Animated.View
              accessibilityViewIsModal
              entering={ZoomIn.springify()
                .mass(pop.mass)
                .stiffness(pop.stiffness)
                .damping(pop.damping)
                .withInitialValues({ transform: [{ scale: 0.94 }] })}
              exiting={FadeOut.duration(motion.state)}
              className="w-full max-w-sm gap-2 rounded-xl border border-border bg-surface p-6"
              style={{ elevation: OVERLAY_ELEVATION }}
            >
              <Text
                accessibilityRole="header"
                face="display"
                className="text-xl text-foreground"
                style={{ letterSpacing: displaySpacing(20) }}
              >
                {asked.title}
              </Text>
              <Text className="text-base text-muted-foreground">{asked.body}</Text>
              <View className="flex-row flex-wrap justify-end gap-2 pt-4">
                {/* Each takes its share of the row it is on, so answers that wrap stack evenly. */}
                <Button ref={keep} grow variant="secondary" label={asked.cancel} onPress={close} />
                <Button
                  grow
                  variant="destructive"
                  label={asked.confirm}
                  onPress={() => {
                    close();
                    asked.onConfirm();
                  }}
                />
              </View>
            </Animated.View>
          </View>
        )}
      </Modal>
    </AskContext>
  );
}

/**
 * Asks before something that cannot be undone, naming what goes and what
 * stays; `onConfirm` runs only once the operator agrees.
 */
export const useConfirm = (): ((question: Question) => void) => {
  const ask = use(AskContext);
  if (ask === null) throw new Error("useConfirm needs Confirmations above it.");
  return ask;
};
