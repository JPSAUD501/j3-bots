// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "../motion.ts";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";

const slide = reanimatedSpring(springs.slide);

/**
 * A panel that rises from the bottom over the scrim, on `slide`, to show more
 * of something without leaving where the operator is, and sinks back on
 * `out`. Back, or a tap on the scrim, closes it. A screen reader starts at
 * its title. It takes at most most of the screen; what it holds scrolls in
 * it, and its `footer` stays under that.
 */
export function Sheet({
  open,
  title,
  lead,
  onClose,
  footer,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  /** What stands before the title, such as a bot's face. */
  readonly lead?: ReactNode;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // The modal stays up while the panel leaves, then goes, on a timer rather
  // than the animation's own end, as the confirmations do, so a modal with
  // nothing left in it never stays over the app taking its touches.
  const [held, setHeld] = useState(open);
  if (open && !held) setHeld(true);
  useEffect(() => {
    if (open || !held) return;
    const timer = setTimeout(() => setHeld(false), reduced ? 0 : motion.state);
    return () => clearTimeout(timer);
  }, [open, held, reduced]);
  return (
    <Modal
      visible={held}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={onClose}
    >
      {open && (
        <View className="flex-1 justify-end">
          <Animated.View
            entering={FadeIn.duration(motion.slow)}
            exiting={FadeOut.duration(motion.state)}
            className="absolute inset-0 bg-scrim"
          >
            <Pressable
              accessible={false}
              importantForAccessibility="no"
              onPress={onClose}
              className="flex-1"
            />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            entering={SlideInDown.springify()
              .mass(slide.mass)
              .stiffness(slide.stiffness)
              .damping(slide.damping)}
            exiting={SlideOutDown.duration(motion.state)}
            className="rounded-t-xl border border-b-0 border-border bg-surface"
            style={{
              maxHeight: window.height * 0.75,
              paddingBottom: insets.bottom,
              elevation: OVERLAY_ELEVATION,
            }}
          >
            <View className="items-center pt-2 pb-1">
              <View className="h-1 w-9 rounded-pill bg-border" />
            </View>
            <Title lead={lead}>{title}</Title>
            <ScrollView contentContainerClassName="px-5 pb-4">{children}</ScrollView>
            {footer}
          </Animated.View>
        </View>
      )}
    </Modal>
  );
}

/** The sheet's title, which a screen reader is moved to as the sheet comes in. */
function Title({ lead, children }: { readonly lead: ReactNode; readonly children: string }) {
  const title = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (title.current !== null) AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
  }, []);
  return (
    <View className="flex-row items-center gap-2 px-5 pt-2 pb-3">
      {lead}
      <Text
        ref={title}
        accessibilityRole="header"
        className="min-w-0 flex-1 text-base font-medium text-foreground"
      >
        {children}
      </Text>
    </View>
  );
}
