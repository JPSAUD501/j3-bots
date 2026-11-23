// SPDX-License-Identifier: AGPL-3.0-or-later
import { lift, motion, reanimatedSpring, shadows, springs } from "@j3-bots/design-tokens";
import { Check, ChevronRight, type LucideIcon } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { I18nManager, Modal, Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { Icon } from "./Icon.tsx";

/**
 * One row of a menu: what it does, an icon, and, when it needs one, a quieter
 * second line. A destructive row is drawn in `blocked`. A row that `opens`
 * another page keeps the menu open, and its `onPress` shows that page in its
 * place: one going on to more rows carries a chevron, and one going `back`
 * says so with its icon alone. A `checked` row is the choice already made,
 * marked at its end.
 */
export interface MenuEntry {
  /** What the row is known by among its page's rows, when its label may repeat. */
  readonly key?: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly hint?: string;
  readonly tone?: "destructive";
  readonly opens?: "page" | "back";
  readonly checked?: true;
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
/** The least room the menu keeps between itself and the window's edge. */
const EDGE = 8;
/** The menu's width when there is room for it, unless the caller asks for more. */
const WIDTH = 224;

const pop = reanimatedSpring(springs.pop);

/**
 * What the menu is about, over the scrim where it was: it rises to a row's
 * lift on `pop`, with the lift shadow, as a row does when it travels in a
 * reorder, and fades as the menu closes. Screen readers skip it: the menu's
 * label names it.
 */
function Preview({
  anchor,
  children,
}: {
  readonly anchor: MenuAnchor;
  readonly children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  const raised = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) raised.set(withSpring(1, pop));
  }, [raised, reduced]);
  const scaled = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (lift.scale - 1) * raised.get() }],
  }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      exiting={FadeOut.duration(motion.fast)}
      className="absolute rounded-lg bg-background"
      style={[
        {
          left: anchor.x,
          top: anchor.y,
          width: anchor.width,
          height: anchor.height,
          boxShadow: shadows.lift[theme],
        },
        scaled,
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A menu that drops from under the button that opened it, as the web's New
 * menu does: a `surface` card over a scrim, its end edge on the button's, which
 * pops in on `pop` from that corner and fades away. A button at the start of
 * its row, as the composer's, lines it up with its start edge instead; from a
 * button in the lower half of the window it opens upward. Measured against the
 * window, it stays by its button however the screen is split, as beside a
 * conversation on a tablet or an unfolded phone. A long-pressed row opens one
 * the same way, with the row itself as the button and drawn again above the
 * scrim (`preview`). Open while `anchor` is set. A press on a row closes it,
 * then acts; a press outside or Back closes it.
 */
export function Menu(props: {
  readonly anchor: MenuAnchor | null;
  readonly onClose: () => void;
  /**
   * What the system's Back does instead of closing the menu: on a page a row
   * opened, it goes back to the one before, as the page's Back row does.
   */
  readonly onBack?: () => void;
  /** Names the menu for screen readers. */
  readonly label: string;
  readonly entries: ReadonlyArray<MenuEntry>;
  /**
   * Which of the menu's pages `entries` are, when a row `opens` another: a
   * new page fades in over the last in the same card.
   */
  readonly page?: string;
  /** The button's edge the menu lines up with: its end unless said otherwise. */
  readonly edge?: "start" | "end";
  /** The menu's width when there is room for it. */
  readonly width?: number;
  /**
   * What the menu is about, drawn again over the scrim exactly where
   * `anchor` is, lifted a little, as a long-pressed row is, so it stays in
   * view, clear of the dimmed screen, while the menu is open.
   */
  readonly preview?: ReactNode;
}) {
  const { anchor } = props;
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const width = props.width ?? WIDTH;
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
  // The room from the button's left and right edges to the window's far edges.
  const rightward = anchor === null ? width : window.width - anchor.x - EDGE;
  const leftward = anchor === null ? width : anchor.x + anchor.width - EDGE;
  const fromLeft = (props.edge === "start") !== rtl;
  const above = anchor !== null && anchor.y + anchor.height / 2 > window.height / 2;
  // The menu narrows to the room it has rather than run off the screen, as in a narrow roster. Its
  // width is set, not left to its rows, so a row whose text wraps, at a large font size, is
  // measured at the width it wraps to and the card holds every row.
  const room = fromLeft ? rightward : leftward;
  return (
    <Modal
      visible={held !== null}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={props.onBack ?? props.onClose}
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
          {props.preview !== undefined && <Preview anchor={anchor}>{props.preview}</Preview>}
          <Animated.View
            accessibilityRole="menu"
            accessibilityLabel={props.label}
            entering={ZoomIn.springify()
              .mass(pop.mass)
              .stiffness(pop.stiffness)
              .damping(pop.damping)
              .withInitialValues({ transform: [{ scale: 0.9 }] })}
            exiting={ZoomOut.duration(motion.fast)}
            className="absolute gap-0.5 rounded-lg border border-border bg-surface p-1.5"
            style={{
              ...(above
                ? { bottom: window.height - anchor.y + GAP }
                : { top: anchor.y + anchor.height + GAP }),
              ...(fromLeft
                ? { left: anchor.x }
                : { right: window.width - anchor.x - anchor.width }),
              transformOrigin: `${above ? "bottom" : "top"} ${fromLeft ? "left" : "right"}`,
              width: Math.min(width, room),
              elevation: OVERLAY_ELEVATION,
            }}
          >
            <Rows page={props.page} entries={props.entries} onClose={props.onClose} />
          </Animated.View>
        </>
      )}
    </Modal>
  );
}

/**
 * The menu's rows. A row that opens another page shows it in place: the new
 * rows fade in, where the first page comes in with the card.
 */
function Rows({
  page,
  entries,
  onClose,
}: {
  readonly page: string | undefined;
  readonly entries: ReadonlyArray<MenuEntry>;
  readonly onClose: () => void;
}) {
  const [first] = useState(page);
  return (
    <Animated.View
      key={page ?? "menu"}
      {...(page === first ? {} : { entering: FadeIn.duration(motion.state) })}
      className="gap-0.5"
    >
      {entries.map((entry) => (
        <PressScale
          key={entry.key ?? entry.label}
          depth="row"
          accessibilityRole="menuitem"
          accessibilityLabel={entry.label}
          accessibilityHint={entry.hint}
          accessibilityState={entry.checked === true ? { checked: true } : undefined}
          onPress={() => {
            if (entry.opens === undefined) onClose();
            entry.onPress();
          }}
          className="min-h-11 flex-row items-start gap-3 rounded-md px-3 py-2.5 active:bg-muted"
        >
          <View className="pt-0.5">
            <Icon
              icon={entry.icon}
              size={18}
              color={entry.tone === "destructive" ? "accent-blocked" : "accent-muted-foreground"}
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text
              className={`text-base ${entry.tone === "destructive" ? "text-blocked" : "text-foreground"}`}
            >
              {entry.label}
            </Text>
            {entry.hint !== undefined && (
              <Text className="max-w-56 text-sm text-muted-foreground">{entry.hint}</Text>
            )}
          </View>
          {entry.opens === "page" && (
            <View className="self-center">
              <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
            </View>
          )}
          {entry.checked === true && (
            <View className="self-center">
              <Icon icon={Check} size={18} color="accent-accent" />
            </View>
          )}
        </PressScale>
      ))}
    </Animated.View>
  );
}
