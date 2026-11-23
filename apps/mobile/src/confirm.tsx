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
interface Confirmation {
  readonly title: string;
  readonly body: string;
  /** The answer that keeps things as they are, which comes first. */
  readonly cancel: string;
  /** The answer that acts, which cannot be undone unless `reversible`. */
  readonly confirm: string;
  readonly onConfirm: () => void;
  /**
   * The answer that acts can be taken back, as giving a bot back its browser
   * tab can: it is the primary answer then, not a destructive one.
   */
  readonly reversible?: boolean;
}

const AskContext = createContext<((confirmation: Confirmation) => void) | null>(null);

const pop = reanimatedSpring(springs.pop);

/**
 * Asks before something that cannot be undone, or before leaving something
 * the operator holds, in the app's own short dialog
 * rather than the system's alert, so it reads and moves like every other
 * surface: a `surface` panel over the scrim that pops in from slightly
 * smaller on `pop` and leaves on `out`. The answer that keeps things as they
 * are comes first; Back or a tap outside gives that answer too.
 */
export function Confirmations({ children }: { readonly children: ReactNode }) {
  const [asked, setAsked] = useState<Confirmation | null>(null);
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
            <Panel
              confirmation={asked}
              onCancel={close}
              onConfirm={() => {
                close();
                asked.onConfirm();
              }}
            />
          </View>
        )}
      </Modal>
    </AskContext>
  );
}

/**
 * The dialog itself. A screen reader starts at its title, so the question is
 * heard before the answers, then reads on to the body and Keep. That happens
 * as the panel comes in, not when the modal shows, so a confirmation asked
 * while the last one leaves, with the modal still up, is read from its title
 * too.
 */
function Panel({
  confirmation,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: Confirmation;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const title = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (title.current !== null) AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
  }, []);
  return (
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
        ref={title}
        accessibilityRole="header"
        face="display"
        className="text-xl text-foreground"
        style={{ letterSpacing: displaySpacing(20) }}
      >
        {confirmation.title}
      </Text>
      <Text className="text-base text-muted-foreground">{confirmation.body}</Text>
      <View className="flex-row flex-wrap justify-end gap-2 pt-4">
        {/* Each takes its share of the row it is on, so answers that wrap stack evenly. */}
        <Button grow variant="secondary" label={confirmation.cancel} onPress={onCancel} />
        <Button
          grow
          variant={confirmation.reversible === true ? "primary" : "destructive"}
          label={confirmation.confirm}
          onPress={onConfirm}
        />
      </View>
    </Animated.View>
  );
}

/**
 * Asks before something that cannot be undone, naming what goes and what
 * stays; `onConfirm` runs only once the operator agrees.
 */
export const useConfirm = (): ((confirmation: Confirmation) => void) => {
  const ask = use(AskContext);
  if (ask === null) throw new Error("useConfirm needs Confirmations above it.");
  return ask;
};
