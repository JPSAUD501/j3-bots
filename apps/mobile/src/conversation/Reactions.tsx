// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  QUICK_REACTIONS,
  REACTION_GROUPS,
  type ReactionPill,
  ownReaction,
  reactionAfterPick,
  reactionPills,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { EntryId, Reaction, ReactionEmoji, Reactor } from "@j3-bots/contracts";
import { lift, motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { SmilePlus } from "lucide-react-native";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { I18nManager, Modal, Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  type EntryExitAnimationFunction,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import type { MenuAnchor } from "../components/Menu.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useReducedMotion } from "../motion.ts";
import { feelLongPress } from "../platform/haptics.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { AnimatedView } from "./animated.ts";

/** A message the operator long-pressed, to react to. */
export interface ReactionTarget {
  readonly entryId: EntryId;
  readonly reactions: ReadonlyArray<Reaction>;
  /** Where the message is, in window coordinates. */
  readonly anchor: MenuAnchor;
  /** The side of the conversation the message stands on. */
  readonly side: "start" | "end";
  /**
   * The message's words, drawn again over the scrim where they are, so they
   * stay in view and can be selected; null for a message without words.
   */
  readonly preview: { readonly at: MenuAnchor; readonly content: ReactNode } | null;
}

interface Reacting {
  /** Opens the quick bar over the message. */
  readonly open: (target: ReactionTarget) => void;
  /** Sets the operator's reaction on the message, or takes it off with null. */
  readonly react: (entryId: EntryId, emoji: ReactionEmoji | null) => void;
  /** Shows who reacted with one emoji. */
  readonly showWho: (pill: ReactionPill) => void;
}

const ReactingContext = createContext<Reacting | null>(null);

/** What reacting to a message does in this conversation. */
export const useReacting = (): Reacting => {
  const reacting = use(ReactingContext);
  if (reacting === null) throw new Error("useReacting needs Reactions above it.");
  return reacting;
};

/**
 * Reacting to the messages of one conversation: one quick bar, one picker
 * and one list of who reacted, which every message opens. A reaction the
 * server did not take says so in a toast; one it took comes back with the
 * message.
 */
export function Reactions({ children }: { readonly children: ReactNode }) {
  const client = useJ3Client();
  const say = useSay();
  const { t } = usePresentation().i18n;
  const [bar, setBar] = useState<ReactionTarget | null>(null);
  const [picking, setPicking] = useState<ReactionTarget | null>(null);
  const [who, setWho] = useState<ReactionPill | null>(null);
  const react = useCallback(
    (entryId: EntryId, emoji: ReactionEmoji | null) => {
      void client.react(entryId, emoji).then((result) => {
        if (result._tag === "failed") say(t("reaction.failed"));
      });
    },
    [client, say, t],
  );
  const value = useMemo<Reacting>(() => ({ open: setBar, react, showWho: setWho }), [react]);
  const pick = (target: ReactionTarget, emoji: ReactionEmoji) =>
    react(target.entryId, reactionAfterPick(target.reactions, emoji));
  return (
    <ReactingContext value={value}>
      {children}
      <QuickBar
        target={bar}
        onClose={() => setBar(null)}
        onPick={(target, emoji) => {
          setBar(null);
          pick(target, emoji);
        }}
        onMore={(target) => {
          setBar(null);
          setPicking(target);
        }}
      />
      <Sheet open={picking !== null} title={t("reaction.picker")} onClose={() => setPicking(null)}>
        {picking !== null && (
          <Picker
            own={ownReaction(picking.reactions)}
            onPick={(emoji) => {
              setPicking(null);
              pick(picking, emoji);
            }}
          />
        )}
      </Sheet>
      <Sheet
        open={who !== null}
        title={t("reaction.who")}
        lead={who === null ? undefined : <Text className="text-2xl">{who.emoji}</Text>}
        onClose={() => setWho(null)}
      >
        {who !== null && <Who by={who.by} />}
      </Sheet>
    </ReactingContext>
  );
}

/** A quick bar's button: a full touch, unless the window is too narrow for the bar. */
const BUTTON = 44;
/** The bar's padding and its border, on each side. */
const INSET = 5;
/** The gap between the message and the bar. */
const GAP = 6;
/** The least room the bar keeps from the window's edge. */
const EDGE = 8;

const pop = reanimatedSpring(springs.pop);

/**
 * The quick bar, over the scrim by the long-pressed message, whose words are
 * drawn again where they were, lifted a little, as a long-pressed row is: above the
 * message when there is room, under it when not, and at the top over a
 * message taller than the window. It pops in on `pop` from its corner by the
 * message and fades as it closes. A tap outside or Back closes it.
 */
function QuickBar({
  target,
  onClose,
  onPick,
  onMore,
}: {
  readonly target: ReactionTarget | null;
  readonly onClose: () => void;
  readonly onPick: (target: ReactionTarget, emoji: ReactionEmoji) => void;
  readonly onMore: (target: ReactionTarget) => void;
}) {
  const reduced = useReducedMotion();
  // The modal stays up while the bar leaves, then goes, on a timer rather than the animation's own
  // end, as the menus do, so a modal with nothing left in it never stays over the app taking its
  // touches. Reduced motion plays nothing, so nothing holds it.
  const [held, setHeld] = useState(target);
  if (target !== null && target !== held) setHeld(target);
  useEffect(() => {
    if (target !== null || held === null) return;
    const timer = setTimeout(() => setHeld(null), reduced ? 0 : motion.fast);
    return () => clearTimeout(timer);
  }, [target, held, reduced]);
  return (
    <Modal
      visible={held !== null}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={onClose}
    >
      {target !== null && (
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
              onPress={onClose}
              className="flex-1"
            />
          </Animated.View>
          {target.preview !== null && (
            <Lifted at={target.preview.at} side={target.side}>
              {target.preview.content}
            </Lifted>
          )}
          <Bar
            anchor={target.anchor}
            side={target.side}
            own={ownReaction(target.reactions)}
            onPick={(emoji) => onPick(target, emoji)}
            onMore={() => onMore(target)}
          />
        </>
      )}
    </Modal>
  );
}

/** The bar itself, placed by the message on its side, each emoji a button, then "more". */
function Bar({
  anchor,
  side,
  own,
  onPick,
  onMore,
}: {
  readonly anchor: MenuAnchor;
  readonly side: "start" | "end";
  readonly own: ReactionEmoji | null;
  readonly onPick: (emoji: ReactionEmoji) => void;
  readonly onMore: () => void;
}) {
  const { t } = usePresentation().i18n;
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const count = QUICK_REACTIONS.length + 1;
  const size = Math.min(BUTTON, Math.floor((window.width - 2 * EDGE - 2 * INSET) / count));
  const width = count * size + 2 * INSET;
  const height = size + 2 * INSET;
  const top = insets.top + EDGE;
  const above = anchor.y - GAP - height;
  const below = anchor.y + anchor.height + GAP;
  const y =
    above >= top ? above : below + height <= window.height - insets.bottom - EDGE ? below : top;
  // The bar's edge on the message's side lines up with the message's, inside the window.
  const fromLeft = (side === "start") !== I18nManager.isRTL;
  const inside = (edge: number) => Math.min(Math.max(EDGE, edge), window.width - EDGE - width);
  return (
    <Animated.View
      accessibilityRole="toolbar"
      accessibilityLabel={t("reaction.add")}
      accessibilityViewIsModal
      entering={ZoomIn.springify()
        .mass(pop.mass)
        .stiffness(pop.stiffness)
        .damping(pop.damping)
        .withInitialValues({ transform: [{ scale: 0.9 }] })}
      exiting={ZoomOut.duration(motion.fast)}
      className="absolute flex-row rounded-pill border border-border bg-surface"
      style={{
        top: y,
        ...(fromLeft
          ? { left: inside(anchor.x) }
          : { right: inside(window.width - anchor.x - anchor.width) }),
        padding: INSET - 1,
        transformOrigin: `${y < anchor.y ? "bottom" : "top"} ${fromLeft ? "left" : "right"}`,
        elevation: OVERLAY_ELEVATION,
      }}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <Pressable
          key={emoji}
          accessibilityRole="button"
          accessibilityLabel={emoji}
          accessibilityState={{ selected: emoji === own }}
          onPress={() => onPick(emoji)}
          className={`items-center justify-center rounded-full active:bg-muted ${emoji === own ? "bg-accent/12" : ""}`}
          style={{ width: size, height: size }}
        >
          <Text className="text-2xl">{emoji}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("reaction.more")}
        onPress={onMore}
        className="items-center justify-center rounded-full active:bg-muted"
        style={{ width: size, height: size }}
      >
        <Icon icon={SmilePlus} size={22} color="accent-muted-foreground" />
      </Pressable>
    </Animated.View>
  );
}

/**
 * The long-pressed message's words over the scrim, where they were, risen a
 * little on `pop`, so they stay in view, clear of the dimmed conversation.
 * They can be selected there. Screen readers skip them: the bar is what is
 * open.
 */
function Lifted({
  at,
  side,
  children,
}: {
  readonly at: MenuAnchor;
  readonly side: "start" | "end";
  readonly children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const raised = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) raised.set(withSpring(1, pop));
  }, [raised, reduced]);
  const scaled = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (lift.scale - 1) * raised.get() }],
  }));
  return (
    <AnimatedView
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="box-none"
      exiting={FadeOut.duration(motion.fast)}
      className="absolute"
      style={[
        {
          left: at.x,
          top: at.y,
          width: at.width,
          transformOrigin: side === "end" ? "right center" : "left center",
        },
        scaled,
      ]}
    >
      {children}
    </AnimatedView>
  );
}

/** The picker's emoji: each group under its name, drawn by the system's font. */
function Picker({
  own,
  onPick,
}: {
  readonly own: ReactionEmoji | null;
  readonly onPick: (emoji: ReactionEmoji) => void;
}) {
  const { t } = usePresentation().i18n;
  return (
    <View className="gap-4">
      {REACTION_GROUPS.map((group) => (
        <View key={group.id} className="gap-1">
          <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
            {t(`reaction.group.${group.id}`)}
          </Text>
          <View className="flex-row flex-wrap">
            {group.emoji.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={emoji}
                accessibilityState={{ selected: emoji === own }}
                onPress={() => onPick(emoji)}
                className={`size-11 items-center justify-center rounded-md active:bg-muted ${emoji === own ? "bg-accent/12" : ""}`}
              >
                <Text className="text-2xl">{emoji}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Who reacted with one emoji, in the order they did. */
function Who({ by }: { readonly by: ReadonlyArray<Reactor> }) {
  const { t } = usePresentation().i18n;
  const bots = useBots();
  return (
    <View>
      {by.map((reactor) => (
        <Text
          key={reactor._tag === "operator" ? "operator" : reactor.botId}
          numberOfLines={1}
          className="py-2.5 text-base text-foreground"
        >
          {reactor._tag === "operator"
            ? t("reaction.you")
            : (bots.get(reactor.botId)?.profile.name ?? t("bot.unknown"))}
        </Text>
      ))}
    </View>
  );
}

/**
 * How a pill arrives: it fades in and pops up from smaller, quickly, on
 * `pop`. Reanimated settles it at once where the system asks for reduced
 * motion.
 */
const pillIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.6 }] },
    animations: {
      opacity: withTiming(1, { duration: motion.fast }),
      transform: [{ scale: withSpring(1, pop) }],
    },
  };
};

/**
 * A message's reactions, under it: a pill for each emoji, with how many when
 * more than one, the operator's own drawn chosen. A tap on the operator's
 * takes it off; a tap on another makes it theirs. A long press shows who
 * reacted. What was there when the message was drawn shows in place; a pill
 * that comes after pops in.
 */
export function ReactionPills({
  entryId,
  reactions,
  side,
  maxWidth,
}: {
  readonly entryId: EntryId;
  readonly reactions: ReadonlyArray<Reaction>;
  readonly side: "start" | "end";
  readonly maxWidth: number;
}) {
  const reacting = useReacting();
  const { i18n } = usePresentation();
  const pills = reactionPills(reactions);
  const [drawn] = useState(() => new Set(pills.map((pill) => pill.emoji)));
  if (pills.length === 0) return null;
  return (
    <View
      style={{ maxWidth }}
      className={`flex-row flex-wrap gap-1.5 ${side === "end" ? "justify-end" : ""}`}
    >
      {pills.map((pill) => (
        <AnimatedView key={pill.emoji} {...(drawn.has(pill.emoji) ? {} : { entering: pillIn })}>
          <PressScale
            accessibilityRole="button"
            accessibilityLabel={
              pill.mine
                ? i18n.t("reaction.pill.mine", { emoji: pill.emoji })
                : i18n.plural("reaction.pill", pill.count, { emoji: pill.emoji })
            }
            accessibilityState={{ selected: pill.mine }}
            accessibilityActions={[{ name: "longpress", label: i18n.t("reaction.who") }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "longpress") reacting.showWho(pill);
            }}
            onPress={() => reacting.react(entryId, reactionAfterPick(reactions, pill.emoji))}
            onLongPress={() => {
              feelLongPress();
              reacting.showWho(pill);
            }}
            // A pill is shorter than a touch: its touch box reaches the rest of the way.
            hitSlop={{ top: 8, bottom: 8 }}
            className={`flex-row items-center gap-1 rounded-pill border px-2 py-0.5 ${
              pill.mine ? "border-accent bg-accent/12" : "border-border bg-surface"
            }`}
          >
            <Text className="text-sm">{pill.emoji}</Text>
            {pill.count > 1 && (
              <Text
                className={`text-xs font-medium ${pill.mine ? "text-accent" : "text-muted-foreground"}`}
              >
                {pill.count}
              </Text>
            )}
          </PressScale>
        </AnimatedView>
      ))}
    </View>
  );
}
