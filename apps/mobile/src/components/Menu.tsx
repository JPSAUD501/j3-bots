// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { LucideIcon } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useReducedMotion } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Icon } from "./Icon.tsx";

/** One row of a menu: what it does, an icon, and, when it needs one, a quieter second line. */
export interface MenuEntry {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly hint?: string;
  readonly onPress: () => void;
}

const pop = reanimatedSpring(springs.pop);

/**
 * A menu that drops from the top end of the screen, under the button that
 * opened it, as the web's New menu does: a `surface` card over a scrim, which
 * pops in on `pop` and fades away. A press on a row closes it, then acts; a
 * press outside or Back closes it. Reduced motion shows and hides it at once
 * (Reanimated follows the system's setting).
 */
export function Menu(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Names the menu for screen readers. */
  readonly label: string;
  readonly entries: ReadonlyArray<MenuEntry>;
}) {
  const insets = useSafeAreaInsets();
  // The modal stays up after `open` turns false until the card has played its
  // way out; opened again meanwhile, it simply stays. Reduced motion plays
  // nothing, so nothing holds it.
  const reduced = useReducedMotion();
  const [wasOpen, setWasOpen] = useState(props.open);
  const [leaving, setLeaving] = useState(false);
  if (wasOpen !== props.open) {
    setWasOpen(props.open);
    setLeaving(!props.open);
  }
  const gone = useCallback(() => setLeaving(false), []);
  return (
    <Modal
      visible={props.open || (leaving && !reduced)}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={props.onClose}
    >
      {props.open && (
        <>
          <Animated.View
            entering={FadeIn.duration(motion.state)}
            exiting={FadeOut.duration(motion.fast)}
            className="absolute inset-0 bg-scrim"
          >
            {/* A tap outside closes it; screen readers close it with Back, as any dialog. */}
            <Pressable
              accessible={false}
              importantForAccessibility="no"
              onPress={props.onClose}
              className="flex-1"
            />
          </Animated.View>
          <Animated.View
            accessibilityRole="menu"
            accessibilityLabel={props.label}
            entering={ZoomIn.springify()
              .mass(pop.mass)
              .stiffness(pop.stiffness)
              .damping(pop.damping)
              .withInitialValues({ transform: [{ scale: 0.9 }] })}
            exiting={ZoomOut.duration(motion.fast).withCallback(() => {
              "worklet";
              scheduleOnRN(gone);
            })}
            className="absolute end-3 min-w-56 gap-0.5 rounded-lg border border-border bg-surface p-1.5"
            style={{ top: insets.top + 56, elevation: 8 }}
          >
            {props.entries.map((entry) => (
              <PressScale
                key={entry.label}
                depth="row"
                accessibilityRole="menuitem"
                accessibilityLabel={entry.label}
                accessibilityHint={entry.hint}
                onPress={() => {
                  props.onClose();
                  entry.onPress();
                }}
                className="min-h-11 flex-row items-start gap-3 rounded-md px-3 py-2.5 active:bg-muted"
              >
                <View className="pt-0.5">
                  <Icon icon={entry.icon} size={18} color="accent-muted-foreground" />
                </View>
                <View className="min-w-0 shrink gap-0.5">
                  <Text className="text-base text-foreground">{entry.label}</Text>
                  {entry.hint !== undefined && (
                    <Text className="max-w-56 text-sm text-muted-foreground">{entry.hint}</Text>
                  )}
                </View>
              </PressScale>
            ))}
          </Animated.View>
        </>
      )}
    </Modal>
  );
}
