// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { LucideIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { I18nManager, Modal, Pressable, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import { useReducedMotion } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { Icon } from "./Icon.tsx";

/** One row of a menu: what it does, an icon, and, when it needs one, a quieter second line. */
export interface MenuEntry {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly hint?: string;
  readonly onPress: () => void;
}

/** Where the button that opens a menu is, in window coordinates, as `measureInWindow` gives them. */
export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The gap between the button and the menu under it. */
const GAP = 4;

const pop = reanimatedSpring(springs.pop);

/**
 * A menu that drops from under the button that opened it, as the web's New
 * menu does: a `surface` card over a scrim, its end edge on the button's, which
 * pops in on `pop` from that corner and fades away. Measured against the
 * window, it stays under its button however the screen is split, as beside a
 * conversation on a tablet or an unfolded phone. Open while `anchor` is set. A
 * press on a row closes it, then acts; a press outside or Back closes it.
 */
export function Menu(props: {
  readonly anchor: MenuAnchor | null;
  readonly onClose: () => void;
  /** Names the menu for screen readers. */
  readonly label: string;
  readonly entries: ReadonlyArray<MenuEntry>;
}) {
  const { anchor } = props;
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  // The modal stays up for as long as the card takes to leave, then goes, on
  // a timer rather than the animation's own end, so a modal with nothing left
  // in it can never stay over the app taking its touches. Reduced motion plays
  // nothing, so nothing holds it.
  const [held, setHeld] = useState(anchor);
  if (anchor !== null && anchor !== held) setHeld(anchor);
  useEffect(() => {
    if (anchor !== null || held === null) return;
    const timer = setTimeout(() => setHeld(null), reduced ? 0 : motion.fast);
    return () => clearTimeout(timer);
  }, [anchor, held, reduced]);
  const rtl = I18nManager.isRTL;
  return (
    <Modal
      visible={held !== null}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={props.onClose}
    >
      {anchor !== null && (
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
            exiting={ZoomOut.duration(motion.fast)}
            className="absolute min-w-56 gap-0.5 rounded-lg border border-border bg-surface p-1.5"
            style={{
              top: anchor.y + anchor.height + GAP,
              ...(rtl
                ? { left: anchor.x, transformOrigin: "top left" }
                : { right: window.width - anchor.x - anchor.width, transformOrigin: "top right" }),
              elevation: OVERLAY_ELEVATION,
            }}
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
