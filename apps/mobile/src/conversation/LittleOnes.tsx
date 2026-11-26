// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AvatarPoke,
  createLitter,
  dismissLitter,
  litterLines,
  type LitterPlace,
  litterPokes,
  type LitterSim,
  litterStrands,
  litterTravels,
  littleFace,
  littleSpot,
  perkLittle,
  settleLitter,
  shortDuration,
  stepLitter,
  stillLittle,
  syncLitter,
} from "@j3-bots/client-runtime/presentation";
import { useLittleRows } from "@j3-bots/client-runtime/react";
import { littleOneText } from "@j3-bots/client-runtime/wording";
import type { Avatar, LittleOne, LittleOnes as TurnLittleOnes } from "@j3-bots/contracts";
import {
  type AvatarShapeName,
  avatarBodyColor,
  avatarFrame,
  easeOutCurve,
  litter,
  littleColors,
  reanimatedSpring,
  resolveAvatar,
  springs,
} from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { type ComponentRef, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { useUniwind } from "uniwind";
import { type AvatarHandle, LittleBody, useMoves } from "../components/avatar/BotAvatar.tsx";
import { join } from "../components/avatar/scheduler.ts";
import { useI18n } from "../i18n.ts";
import { appear, useReducedMotion } from "../motion.ts";
import { useSeconds } from "../seconds.ts";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { AnimatedView } from "./animated.ts";

/**
 * Where the family stands under a turn's line on a phone: a line tall enough
 * to press, the bot's face 24 px in a row 44 px tall, so its feet stand 10 px
 * above the first line, and each little one three quarters of the bot.
 */
const PARENT = 24;
const SIZE = PARENT * litter.share;
const PLACE: LitterPlace = { row: 36, size: SIZE, parent: PARENT, rise: 10 };
/** Where a little one's feet stand at its line, below the line's top. */
const REST = PLACE.row / 2 + SIZE / 2;

const AnimatedPath = Animated.createAnimatedComponent(Path);
const out = Easing.bezier(...easeOutCurve);
const soft = reanimatedSpring(springs.soft);
const slide = reanimatedSpring(springs.slide);

/** The little one `id` in `sim`, null while the family does not hold it. */
function oneOf(sim: LitterSim, id: string) {
  "worklet";
  for (const one of sim.ones) if (one.id === id) return one;
  return null;
}

interface LittleOnesProps {
  /** The turn's little ones, as the server tells them; null for a turn that has none. */
  readonly littleOnes: TurnLittleOnes | null;
  /** Whether the turn runs: a turn that is over shows none. */
  readonly live: boolean;
  /** The bot's own look, which each little one is a small copy of. */
  readonly avatar: Avatar;
  /** The bot's face beside the turn, which answers as they come and go. */
  readonly face: RefObject<AvatarHandle | null>;
}

/**
 * A bot's little ones, under its face, as on the web: the small copies of
 * itself it splits into while part of its turn runs in parallel, each by one
 * line of what it does, four at most and a count of the rest. They come out
 * from under the bot, land by their lines and bob there; one that ends jumps
 * back up into the bot, grey first if it failed. A tap on one shows its line
 * in full and how long it has worked.
 *
 * The family's model (`presentation/littleOnes.ts`) is stepped on the UI
 * thread by a frame callback, on the avatars' own terms: not off screen, not
 * on a screen behind another, not while its list scrolls, not under reduced
 * motion. Where it does not move, the little ones are simply at their lines,
 * and one that ends is simply gone.
 */
export function LittleOnes({ littleOnes, live, avatar, face }: LittleOnesProps) {
  const { plural } = useI18n();
  const { shape, color } = resolveAvatar(avatar);
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  const reduced = useReducedMotion();
  const { shown, rows, held } = useLittleRows(littleOnes, live);
  const working = shown.ones.map((one) => one.id);
  const key = working.join("\n");
  const failedKey = shown.failed.join("\n");
  const more = shown.more > 0;

  const [initial] = useState(() => createLitter(working, more, PLACE));
  const sim = useSharedValue(initial);
  // Whether the family is drawn still: until a frame steps it, and wherever none does.
  const still = useSharedValue(true);
  const owed = useSharedValue(0);
  const skip = useSharedValue(false);
  const { wants, held: holding } = useMoves();
  const [running, setRunning] = useState(false);

  // What the UI thread tells this one: what the bot answers, and who is left once one is home.
  const poke = useCallback(
    (pokes: ReadonlyArray<AvatarPoke>) => {
      for (const how of pokes) face.current?.poke(how);
    },
    [face],
  );
  const left = useCallback((ids: string) => held(ids === "" ? [] : ids.split("\n")), [held]);

  const frames = useFrameCallback((info) => {
    "worklet";
    if (holding.get()) return;
    const dt = Math.min(0.05, (info.timeSincePreviousFrame ?? 16) / 1000);
    const before = sim.get();
    // Little ones that only bob at their lines step every other frame, as a small avatar does.
    if (!litterTravels(before)) {
      skip.set(!skip.get());
      if (skip.get()) {
        owed.set(owed.get() + dt);
        return;
      }
    }
    const after = stepLitter(before, dt + owed.get(), PLACE);
    owed.set(0);
    sim.set(after);
    still.set(false);
    const pokes = litterPokes(before, after);
    if (pokes.length > 0) scheduleOnRN(poke, pokes);
    if (after.ones.length !== before.ones.length) {
      scheduleOnRN(left, after.ones.map((one) => one.id).join("\n"));
    }
  }, false);

  // The block goes on closing for a moment after its last little one is home.
  const [closing, setClosing] = useState(false);
  const some = rows.length > 0;
  const [had, setHad] = useState(some);
  if (had !== some) {
    setHad(some);
    setClosing(!some);
  }
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), springs.slide.duration + 200);
    return () => clearTimeout(timer);
  }, [closing]);

  // The scheduler decides whether the frame callback runs, as it does for each avatar.
  const moves = wants && (some || closing);
  const latestMoves = useRef(moves);
  const member = useRef<ReturnType<typeof join> | null>(null);
  useEffect(() => {
    latestMoves.current = moves;
    member.current?.want(moves);
  }, [moves]);
  useEffect(() => {
    const joined = join({
      size: SIZE,
      run: (on) => {
        frames.setActive(on);
        setRunning(on);
      },
    });
    joined.want(latestMoves.current);
    member.current = joined;
    return () => {
      joined.leave();
      member.current = null;
    };
  }, [frames]);

  // Who works now. Where nothing steps the family, everyone is where they were going at once;
  // reduced motion keeps one that failed, grey at its line, and lets it go a moment later.
  useEffect(() => {
    const now = key === "" ? [] : key.split("\n");
    const failed = failedKey === "" ? [] : failedKey.split("\n");
    const moving = running && !reduced;
    sim.modify((current) => {
      "worklet";
      const next = live ? syncLitter(current, now, failed, more, PLACE) : dismissLitter(current);
      if (moving) {
        const pokes = litterPokes(current, next);
        if (pokes.length > 0) scheduleOnRN(poke, pokes);
      }
      const drawn = moving ? next : settleLitter(next, PLACE, reduced);
      if (drawn.ones.length !== current.ones.length) {
        scheduleOnRN(left, drawn.ones.map((one) => one.id).join("\n"));
      }
      return drawn;
    });
    if (!moving) still.set(true);
    if (!reduced || failed.length === 0) return;
    const timer = setTimeout(() => {
      sim.modify((current) => {
        "worklet";
        const drawn = settleLitter(current, PLACE, false);
        scheduleOnRN(left, drawn.ones.map((one) => one.id).join("\n"));
        return drawn;
      });
    }, litter.failed * 1000);
    return () => clearTimeout(timer);
  }, [key, failedKey, more, live, running, reduced, sim, still, poke, left]);

  const [open, setOpen] = useState<{ readonly one: LittleOne; readonly anchor: Anchor } | null>(
    null,
  );
  const block = useAnimatedStyle(() => ({ height: Math.max(0, sim.get().height.x) }));
  const strand = useDerivedValue(() => (still.get() ? "" : litterStrands(sim.get(), PLACE)));
  const strandProps = useAnimatedProps(() => ({ d: strand.get() }));
  const count = useAnimatedStyle(() => ({
    transform: [{ translateY: withSpring(litterLines(sim.get()) * PLACE.row, slide) }],
    opacity: withTiming(sim.get().more ? 1 : 0, { duration: 200 }),
  }));
  const bot = avatarBodyColor(color, theme, false);
  const paint = littleColors(color, theme, false);
  return (
    <AnimatedView style={block}>
      <View pointerEvents="none" style={{ position: "absolute", left: PARENT / 2, top: 0 }}>
        <Svg width={1} height={1} style={{ overflow: "visible" }}>
          <AnimatedPath animatedProps={strandProps} fill={bot} />
        </Svg>
      </View>
      {rows.map((one) => (
        <LittleRow
          key={one.id}
          one={one}
          sim={sim}
          still={still}
          shape={shape}
          colors={littleColors(color, theme, shown.failed.includes(one.id))}
          failed={shown.failed.includes(one.id)}
          onOpen={(anchor) => {
            if (!reduced && running) {
              sim.modify((current) => {
                "worklet";
                return perkLittle(current, one.id);
              });
            }
            setOpen({ one, anchor });
          }}
        />
      ))}
      <AnimatedView
        pointerEvents="none"
        style={[{ position: "absolute", left: 0, right: 0, top: 0, height: PLACE.row }, count]}
        className="flex-row items-center gap-2.5"
      >
        <View style={{ width: PARENT }} className="flex-row justify-center gap-0.5">
          {[0, 1].map((dot) => (
            <View
              key={dot}
              style={{ backgroundColor: paint.body, borderColor: paint.rim, borderWidth: 1.5 }}
              className="size-2 rounded-pill"
            />
          ))}
        </View>
        <Text className="text-xs text-muted-foreground">
          {more ? plural("littleOnes.more", shown.more) : ""}
        </Text>
      </AnimatedView>
      {open !== null && (
        <LittleDetails
          one={open.one}
          anchor={open.anchor}
          failed={shown.failed.includes(open.one.id)}
          onClose={() => setOpen(null)}
        />
      )}
    </AnimatedView>
  );
}

/** Where a little one's line is, in window coordinates, as `measureInWindow` gives them. */
interface Anchor {
  readonly x: number;
  readonly y: number;
}

/**
 * One little one and its line. Its place, its size and its face come from the
 * family's model on the UI thread; its words come in as it lands and go as it
 * sets off home. The whole line is what a tap opens.
 */
function LittleRow({
  one,
  sim,
  still,
  shape,
  colors,
  failed,
  onOpen,
}: {
  readonly one: LittleOne;
  readonly sim: SharedValue<LitterSim>;
  readonly still: SharedValue<boolean>;
  readonly shape: AvatarShapeName;
  readonly colors: { readonly body: string; readonly rim: string };
  readonly failed: boolean;
  readonly onOpen: (anchor: Anchor) => void;
}) {
  const i18n = useI18n();
  const id: string = one.id;
  const line = useRef<ComponentRef<typeof View>>(null);
  const spot = useDerivedValue(() => {
    const mine = oneOf(sim.get(), id);
    return mine === null ? null : littleSpot(mine);
  });
  const frame = useDerivedValue(() => {
    const now = sim.get();
    const mine = oneOf(now, id);
    const face =
      mine === null || still.get()
        ? stillLittle(mine !== null && littleSpot(mine).failed)
        : littleFace(mine, now.time);
    return avatarFrame(shape, face, SIZE, true);
  });
  const row = useAnimatedStyle(() => {
    const at = spot.get();
    return {
      transform: [{ translateY: at?.line ?? 0 }],
      // One on its way passes behind the ones that stand.
      zIndex: at?.travelling === true ? 0 : 1,
      opacity: at?.shown === true ? 1 : 0,
    };
  });
  const body = useAnimatedStyle(() => {
    const at = spot.get();
    return {
      transform: [
        { translateY: at === null ? 0 : at.y - at.line - REST },
        { scale: at?.scale ?? 1 },
      ],
    };
  });
  const words = useAnimatedStyle(() => {
    const shown = spot.get()?.words === true;
    return {
      opacity: shown
        ? withSpring(1, soft)
        : withTiming(0, { duration: litter.wordsOut, easing: out }),
      transform: [{ translateX: shown ? withSpring(0, soft) : -6 }],
    };
  });
  return (
    <AnimatedView
      style={[{ position: "absolute", left: 0, right: 0, top: 0, height: PLACE.row }, row]}
    >
      <Pressable
        ref={line}
        accessibilityRole="button"
        accessibilityLabel={littleOneText(one, i18n)}
        hitSlop={{ top: 4, bottom: 4 }}
        onPress={() => line.current?.measureInWindow((x, y) => onOpen({ x, y }))}
        className="h-full flex-row items-center gap-2.5"
      >
        <AnimatedView
          style={[
            { width: SIZE, height: SIZE, marginHorizontal: (PARENT - SIZE) / 2 },
            { transformOrigin: "50% 100%" },
            body,
          ]}
        >
          <LittleBody frame={frame} shape={shape} size={SIZE} body={colors.body} rim={colors.rim} />
        </AnimatedView>
        <AnimatedView style={words} className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={`text-xs ${failed ? "text-muted-foreground" : "text-foreground"}`}
          >
            {littleOneText(one, i18n)}
          </Text>
        </AnimatedView>
      </Pressable>
    </AnimatedView>
  );
}

/**
 * A little one's line in full, and how long it has worked, in a small card
 * over its line. Nothing else: it has no name, no conversation and no result
 * of its own. A press anywhere, or Back, closes it.
 */
function LittleDetails({
  one,
  anchor,
  failed,
  onClose,
}: {
  readonly one: LittleOne;
  readonly anchor: Anchor;
  readonly failed: boolean;
  readonly onClose: () => void;
}) {
  const i18n = useI18n();
  const window = useWindowDimensions();
  const now = useSeconds(!failed);
  const worked = Math.max(0, now - DateTime.toEpochMillis(one.startedAt));
  return (
    <Modal transparent statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" onPress={onClose} style={{ flex: 1 }}>
        <AnimatedView
          entering={appear}
          accessibilityLiveRegion="polite"
          style={{
            position: "absolute",
            left: Math.max(8, anchor.x + PARENT + 10),
            right: 16,
            bottom: Math.max(8, window.height - anchor.y + 4),
            alignItems: "flex-start",
          }}
        >
          <View
            style={{ elevation: OVERLAY_ELEVATION }}
            className="gap-0.5 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <Text className="text-xs text-foreground">{littleOneText(one, i18n)}</Text>
            <Text className="text-xs text-muted-foreground">
              {failed
                ? i18n.t("littleOnes.failed")
                : i18n.t("littleOnes.workingFor", { duration: shortDuration(worked, i18n) })}
            </Text>
          </View>
        </AnimatedView>
      </Pressable>
    </Modal>
  );
}
