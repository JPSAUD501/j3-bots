// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  avatarFace,
  type AvatarPoke,
  avatarSeed,
  type AvatarState,
  createAvatar,
  memberStack,
  pokeAvatar,
  plainTraits,
  setAvatarState,
  stepAvatar,
  stillFace,
} from "@j3-bots/client-runtime/presentation";
import type { Avatar, Bot, BotId, Room } from "@j3-bots/contracts";
import {
  AVATAR_EYE,
  avatarBodyColor,
  avatarEye,
  type AvatarFace,
  type AvatarFrame,
  avatarFrame,
  type AvatarMatrix,
  matrixAttribute,
  type AvatarShapeName,
  avatarShapes,
  avatarSignals,
  type AvatarSignal,
  avatarViewBox,
  motion,
  resolveAvatar,
  roomAvatarShare,
} from "@j3-bots/design-tokens";
import { NavigationContext } from "@react-navigation/native";
import {
  Component,
  createContext,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Ellipse, G, type GProps, Path } from "react-native-svg";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../../motion.ts";
import { Text } from "../../text.tsx";
import { useColor } from "../../theme.ts";
import { join } from "./scheduler.ts";

/**
 * A group placed by `matrix`, the native group's own transform prop, which
 * react-native-svg's TypeScript props leave out because its G computes it from
 * `transform`. Animated props reach the native group directly, so on the UI
 * thread the matrix is what moves it; a render from React gives the same
 * matrix to G as its `transform`.
 */
class MatrixG extends Component<GProps & { readonly matrix?: AvatarMatrix }> {
  override render() {
    const { matrix, ...props } = this.props;
    return (
      <G {...props} {...(matrix === undefined ? {} : { transform: matrixAttribute(matrix) })} />
    );
  }
}

const AnimatedG = Animated.createAnimatedComponent(MatrixG);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

const VIEW_BOX = `${avatarViewBox.x} ${avatarViewBox.y} ${avatarViewBox.size} ${avatarViewBox.size}`;

/*
 * Each moving part reads its own shared value, which holds that part as a
 * number or as text. Setting a shared value to what it already holds wakes
 * nothing, and the frame rounds every length to a quarter pixel
 * (`avatarFrame`), so a part at rest sets no props: a frame redraws only what
 * moved, which is what keeps a list of moving avatars cheap.
 */

/** Numbers as one text, which compares equal while none of them changes. */
function joined(values: ReadonlyArray<number>): string {
  "worklet";
  return values.join(" ");
}

/** The numbers `joined` wrote, `fallback` for any missing. */
function numbers(text: string, count: number, fallback: number): Array<number> {
  "worklet";
  const parts = text.split(" ");
  const found: Array<number> = [];
  for (let i = 0; i < count; i++) found.push(Number(parts[i] ?? fallback));
  return found;
}

function matrixOf(text: string): AvatarMatrix {
  "worklet";
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = numbers(text, 6, 0);
  return [a, b, c, d, e, f];
}

function circleOf(text: string): { cx: number; cy: number; r: number } {
  "worklet";
  const [cx = 0, cy = 0, r = 0] = numbers(text, 3, 0);
  return { cx, cy, r };
}

/** `n` in steps of 1/32, as an opacity or a share is drawn. */
function level(n: number): number {
  "worklet";
  return Math.round(n * 32) / 32;
}
/** Under this size, in px, an avatar steps at half rate. */
const LIST_SIZE = 44;

/** What an avatar sits on, which a room's front member is cut out of. */
export type AvatarGround = "background" | "surface" | "muted";

const groundColor = {
  background: "accent-background",
  surface: "accent-surface",
  muted: "accent-muted",
} as const satisfies Record<AvatarGround, string>;

/** Whether the avatars below are on screen; a list says so for each row. */
const Visible = createContext(true);

/** Which rows of a list are on screen, by key, for each row to read on its own. */
export interface RowsOnScreen {
  readonly set: (keys: ReadonlySet<string>) => void;
  readonly has: (key: string) => boolean;
  readonly subscribe: (changed: () => void) => () => void;
}

export function rowsOnScreen(): RowsOnScreen {
  let shown: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    set: (keys) => {
      shown = keys;
      for (const listener of listeners) listener();
    },
    has: (key) => shown.has(key),
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
  };
}

/**
 * Says whether the row `rowKey` is on screen to the avatars in it. Each row
 * reads it on its own, so a scroll renders again only the rows that came or
 * went, not the whole list.
 */
export function AvatarRow({
  rows,
  rowKey,
  children,
}: {
  readonly rows: RowsOnScreen;
  readonly rowKey: string;
  readonly children: ReactNode;
}) {
  const visible = useSyncExternalStore(rows.subscribe, () => rows.has(rowKey));
  return <Visible value={visible}>{children}</Visible>;
}

/**
 * Whether the avatars below hold where they are, read on the UI thread: a
 * list holds its avatars while it scrolls, which keeps the scroll smooth, and
 * they go on from there once it settles.
 */
const Held = createContext<SharedValue<boolean>>(makeMutable(false));

export function AvatarHold({
  held,
  children,
}: {
  readonly held: SharedValue<boolean>;
  readonly children: ReactNode;
}) {
  return <Held value={held}>{children}</Held>;
}

/** Whether the screen the avatar is on is the one in front. Outside a navigator, it is. */
function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const subscribe = useCallback(
    (changed: () => void) => {
      if (navigation === undefined) return () => {};
      const offFocus = navigation.addListener("focus", changed);
      const offBlur = navigation.addListener("blur", changed);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation],
  );
  return useSyncExternalStore(subscribe, () => navigation?.isFocused() ?? true);
}

/** Whether the app has gone without the server long enough for the bots to sleep (`AvatarConnection`). */
export const AvatarsAsleep = createContext(false);

/** The colors an avatar paints with, in the theme shown now. */
function usePaint(color: ReturnType<typeof resolveAvatar>["color"], asleep: boolean) {
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  const lights = {
    waiting: useColor("accent-waiting"),
    blocked: useColor("accent-blocked"),
    foreground: useColor("accent-foreground"),
  };
  const body = avatarBodyColor(color, theme, asleep);
  return { body, light: (light: AvatarFace["light"]) => (light === "body" ? body : lights[light]) };
}

export interface AvatarHandle {
  /** Answers something the operator did: a new name, shape or color in the picker. */
  readonly poke: (poke: AvatarPoke) => void;
}

export interface BotAvatarProps {
  readonly avatar: Avatar;
  /** What gives it its own way of moving: the bot's id, or any stable text. */
  readonly seed: string;
  readonly state: AvatarState;
  /** Its turn is stalled: it holds its still form. */
  readonly stalled?: boolean;
  /** In px. */
  readonly size: number;
  /** Draws the still form and never moves, as beside a message. */
  readonly still?: boolean;
  /** Draws a band of what it sits on around the body, to stand clear of what it overlaps. */
  readonly cutout?: boolean;
  /** What it sits on, which the body's cutout and a status light's are drawn in: `background` unless given. */
  readonly ground?: AvatarGround;
  /** Read out for the avatar; without it the avatar is hidden from screen readers. */
  readonly label?: string;
  readonly ref?: Ref<AvatarHandle>;
}

/**
 * A bot's face: its silhouette in its color, one lens eye, and an antenna
 * whose tip is the status light. It moves on the UI thread, on its own seeded
 * clock, in the way its state does. Off screen, on a screen behind another,
 * in the background, under reduced motion, when `still` or while its turn is
 * stalled, it holds its state's still form.
 */
export function BotAvatar(props: BotAvatarProps) {
  const { still = false } = props;
  const accessibility =
    props.label === undefined
      ? ({
          accessibilityElementsHidden: true,
          importantForAccessibility: "no-hide-descendants",
        } as const)
      : ({
          accessible: true,
          accessibilityRole: "image",
          accessibilityLabel: props.label,
        } as const);
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        opacity: props.state === "offline" ? 0.5 : 1,
      }}
      {...accessibility}
    >
      {still ? <StillAvatar {...props} /> : <MovingAvatar key={props.seed} {...props} />}
    </View>
  );
}

/** A band of what the avatar sits on, around its body, under it. */
function Cutout({
  shape,
  ground,
}: {
  readonly shape: AvatarShapeName;
  readonly ground: AvatarGround;
}) {
  const cut = useColor(groundColor[ground]);
  const { path, outline } = avatarShapes[shape];
  return (
    <Path d={path} fill="none" stroke={cut} strokeWidth={outline + 12} strokeLinejoin="round" />
  );
}

/** The silhouette, filled and outlined in the body color, which rounds its corners. */
function Silhouette({ shape, body }: { readonly shape: AvatarShapeName; readonly body: string }) {
  const { path, outline } = avatarShapes[shape];
  return <Path d={path} fill={body} stroke={body} strokeWidth={outline} strokeLinejoin="round" />;
}

function StillAvatar({
  avatar,
  seed,
  state,
  stalled = false,
  size,
  cutout = false,
  ground = "background",
}: BotAvatarProps) {
  const { shape, color } = resolveAvatar(avatar);
  const paint = usePaint(color, state === "offline");
  const cut = useColor(groundColor[ground]);
  const seedNumber = avatarSeed(seed);
  const { face, f } = useMemo(() => {
    const still = stillFace(state, createAvatar(seedNumber, state).traits, stalled);
    return { face: still, f: avatarFrame(shape, still, size) };
  }, [seedNumber, state, stalled, shape, size]);
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX} style={{ overflow: "visible" }}>
      <G transform={matrixAttribute(f.body)}>
        {cutout && <Cutout shape={shape} ground={ground} />}
        <Path
          d={f.stalk}
          fill="none"
          stroke={paint.body}
          strokeWidth={f.stalkWidth}
          strokeLinecap="round"
        />
        <Silhouette shape={shape} body={paint.body} />
        <G transform={matrixAttribute(f.eye)}>
          {f.open ? (
            <>
              <Circle r={AVATAR_EYE} fill={avatarEye.lens} />
              <Circle cx={f.pupil.x} cy={f.pupil.y} r={f.pupil.r} fill={avatarEye.pupil} />
              {f.glint !== null && (
                <Circle
                  cx={f.glint.x}
                  cy={f.glint.y}
                  r={f.glint.r}
                  fill={avatarEye.lens}
                  opacity={0.92}
                />
              )}
              <Path d={f.cheek} fill={paint.body} />
              <Path d={f.upperLid} fill={paint.body} />
              <Path d={f.lowerLid} fill={paint.body} />
            </>
          ) : (
            <Path
              d={f.arc}
              fill="none"
              stroke={avatarEye.lens}
              strokeWidth={f.arcWidth}
              strokeLinecap="round"
              opacity={f.arcOpacity}
            />
          )}
        </G>
        {f.mouth.ry > 0 && (
          <Ellipse
            cx={f.mouth.cx}
            cy={f.mouth.cy}
            rx={f.mouth.rx}
            ry={f.mouth.ry}
            fill={avatarEye.pupil}
          />
        )}
        {f.lightCut > 0 && <Circle cx={f.light.x} cy={f.light.y} r={f.lightCut} fill={cut} />}
        <Circle cx={f.light.x} cy={f.light.y} r={f.light.r} fill={paint.light(face.light)} />
      </G>
    </Svg>
  );
}

function MovingAvatar({
  avatar,
  seed,
  state,
  stalled = false,
  size,
  cutout = false,
  ground = "background",
  ref,
}: BotAvatarProps) {
  const { shape, color } = resolveAvatar(avatar);
  const paint = usePaint(color, state === "offline");
  const cut = useColor(groundColor[ground]);
  const reduced = useReducedMotion();
  const visible = useContext(Visible);
  const held = useContext(Held);
  const focused = useScreenFocused();
  // Keyed by its seed (`BotAvatar`), so one mount is one bot: its sim starts here.
  const [initial] = useState(() => createAvatar(avatarSeed(seed), state));
  const sim = useSharedValue(initial);
  const face = useSharedValue(stillFace(state, initial.traits, stalled));
  const shapeValue = useSharedValue(shape);
  const halfRate = useSharedValue(size < LIST_SIZE);
  const owed = useSharedValue(0);
  // At half rate, half the avatars step on even frames and half on odd ones, so the work is spread.
  const skip = useSharedValue(avatarSeed(seed) % 2 === 0);
  const [running, setRunning] = useState(false);

  const frames = useFrameCallback((info) => {
    "worklet";
    if (held.get()) return;
    const dt = Math.min(0.05, (info.timeSincePreviousFrame ?? 16) / 1000);
    if (halfRate.get()) {
      skip.set(!skip.get());
      if (skip.get()) {
        owed.set(owed.get() + dt);
        return;
      }
    }
    const next = stepAvatar(sim.get(), dt + owed.get(), null);
    owed.set(0);
    sim.set(next);
    face.set(avatarFace(next));
  }, false);

  useEffect(() => {
    shapeValue.set(shape);
    halfRate.set(size < LIST_SIZE);
  }, [shape, size, shapeValue, halfRate]);

  // A change of state turns the sim, which eases into the new pose; a still avatar redraws.
  useEffect(() => {
    sim.modify((current) => {
      "worklet";
      return setAvatarState(current, state);
    });
    if (!running) face.set(stillFace(state, initial.traits, stalled));
  }, [state, stalled, running, initial, sim, face]);

  // The scheduler decides whether the frame callback runs.
  const wants = !stalled && !reduced && visible && focused;
  const latestWants = useRef(wants);
  const member = useRef<ReturnType<typeof join> | null>(null);
  useEffect(() => {
    latestWants.current = wants;
    member.current?.want(wants);
  }, [wants]);
  useEffect(() => {
    const joined = join({
      size,
      run: (on) => {
        frames.setActive(on);
        setRunning(on);
      },
    });
    joined.want(latestWants.current);
    member.current = joined;
    return () => {
      joined.leave();
      member.current = null;
    };
  }, [size, frames]);

  useImperativeHandle(
    ref,
    () => ({
      poke: (poke) => {
        if (!running) return;
        sim.modify((current) => {
          "worklet";
          return pokeAvatar(current, poke);
        });
      },
    }),
    [running, sim],
  );

  const frame = useDerivedValue(() => avatarFrame(shapeValue.get(), face.get(), size));
  const bodyPart = useDerivedValue(() => joined(frame.get().body));
  const stalkPart = useDerivedValue(() => frame.get().stalk);
  const mouthPart = useDerivedValue(() => {
    const { cx, cy, ry } = frame.get().mouth;
    return joined([cx, cy, ry]);
  });
  const signalPart = useDerivedValue(() => joined(frame.get().signal));
  const lightPart = useDerivedValue(() => {
    const { x, y, r } = frame.get().light;
    return joined([x, y, r]);
  });
  const bodyProps = useAnimatedProps(() => ({ matrix: matrixOf(bodyPart.get()) }));
  const stalkProps = useAnimatedProps(() => ({ d: stalkPart.get() }));
  const mouthProps = useAnimatedProps(() => {
    const [cx = 0, cy = 0, ry = 0] = numbers(mouthPart.get(), 3, 0);
    return { cx, cy, ry };
  });
  const signalProps = useAnimatedProps(() => ({ matrix: matrixOf(signalPart.get()) }));
  const cutPart = useDerivedValue(() => {
    const { light, lightCut } = frame.get();
    return joined([light.x, light.y, lightCut]);
  });
  const lightProps = useAnimatedProps(() => circleOf(lightPart.get()));
  const cutProps = useAnimatedProps(() => circleOf(cutPart.get()));
  const still = stillFace(state, plainTraits, stalled);
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX} style={{ overflow: "visible" }}>
      <AnimatedG animatedProps={bodyProps}>
        {cutout && <Cutout shape={shape} ground={ground} />}
        <AnimatedPath
          animatedProps={stalkProps}
          fill="none"
          stroke={paint.body}
          strokeWidth={avatarFrame(shape, still, size).stalkWidth}
          strokeLinecap="round"
        />
        <Silhouette shape={shape} body={paint.body} />
        <Eye frame={frame} body={paint.body} arcWidth={avatarFrame(shape, still, size).arcWidth} />
        {state === "speaking" && (
          <AnimatedEllipse animatedProps={mouthProps} rx={5.2} fill={avatarEye.pupil} />
        )}
        <AnimatedCircle animatedProps={cutProps} fill={cut} />
        <AnimatedG animatedProps={signalProps}>
          <Signal
            key={still.signal ?? "none"}
            signal={still.signal}
            face={face}
            frame={frame}
            body={paint.body}
            waiting={paint.light("waiting")}
            reduced={reduced}
          />
        </AnimatedG>
        <AnimatedCircle animatedProps={lightProps} fill={paint.light(still.light)} />
      </AnimatedG>
    </Svg>
  );
}

function Eye({
  frame,
  body,
  arcWidth,
}: {
  readonly frame: SharedValue<AvatarFrame>;
  readonly body: string;
  readonly arcWidth: number;
}) {
  const eyePart = useDerivedValue(() => joined(frame.get().eye));
  const open = useDerivedValue(() => frame.get().open);
  const pupilPart = useDerivedValue(() => {
    const { x, y, r } = frame.get().pupil;
    return joined([x, y, r]);
  });
  const glintPart = useDerivedValue(() => {
    const glint = frame.get().glint;
    return glint === null ? "0 0 0" : joined([glint.x, glint.y, glint.r]);
  });
  // The cheek and both lids share the body's color, so one path draws them.
  const lids = useDerivedValue(() => {
    const { cheek, upperLid, lowerLid } = frame.get();
    return cheek + upperLid + lowerLid;
  });
  const arc = useDerivedValue(() => frame.get().arc);
  const arcOpacity = useDerivedValue(() => frame.get().arcOpacity);
  const eyeProps = useAnimatedProps(() => ({ matrix: matrixOf(eyePart.get()) }));
  const lensProps = useAnimatedProps(() => ({ opacity: open.get() ? 1 : 0 }));
  const pupilProps = useAnimatedProps(() => circleOf(pupilPart.get()));
  const glintProps = useAnimatedProps(() => circleOf(glintPart.get()));
  const lidsProps = useAnimatedProps(() => ({ d: lids.get() }));
  const arcProps = useAnimatedProps(() => ({ d: arc.get(), opacity: arcOpacity.get() }));
  return (
    <AnimatedG animatedProps={eyeProps}>
      <AnimatedG animatedProps={lensProps}>
        <Circle r={AVATAR_EYE} fill={avatarEye.lens} />
        <AnimatedCircle animatedProps={pupilProps} fill={avatarEye.pupil} />
        <AnimatedCircle animatedProps={glintProps} fill={avatarEye.lens} opacity={0.92} />
        <AnimatedPath animatedProps={lidsProps} fill={body} />
      </AnimatedG>
      <AnimatedPath
        animatedProps={arcProps}
        fill="none"
        stroke={avatarEye.lens}
        strokeWidth={arcWidth}
        strokeLinecap="round"
      />
    </AnimatedG>
  );
}

interface SignalProps {
  readonly face: SharedValue<AvatarFace>;
  readonly frame: SharedValue<AvatarFrame>;
  readonly body: string;
  readonly waiting: string;
}

const signalStroke = {
  strokeWidth: avatarSignals.stroke,
  strokeLinecap: "round",
  fill: "none",
} as const;

/** The state's signal at the light, fading in when the state brings it. */
function Signal({
  signal,
  reduced,
  ...props
}: SignalProps & { readonly signal: AvatarSignal | null; readonly reduced: boolean }) {
  const shown = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    shown.set(withTiming(1, { duration: motion.state }));
  }, [shown]);
  const fade = useAnimatedProps(() => ({ opacity: shown.get() }));
  if (signal === null) return null;
  return (
    <AnimatedG animatedProps={fade}>
      {signal === "ring" && <Ring {...props} />}
      {signal === "ping" && <Ping {...props} />}
      {signal === "arcs" &&
        avatarSignals.arcs.map((d, index) => <SoundArc key={d} d={d} index={index} {...props} />)}
      {signal === "dots" &&
        avatarSignals.dots.map((dot, index) => (
          <ThoughtDot key={`${dot.x} ${dot.y}`} dot={dot} index={index} {...props} />
        ))}
    </AnimatedG>
  );
}

/** The dashed ring that turns while the bot works. */
function Ring({ frame, body }: SignalProps) {
  const ringPart = useDerivedValue(() => joined(frame.get().ring));
  const turn = useAnimatedProps(() => ({ matrix: matrixOf(ringPart.get()) }));
  return (
    <AnimatedG animatedProps={turn}>
      <Circle
        r={avatarSignals.ring.r}
        stroke={body}
        strokeDasharray={[...avatarSignals.ring.dash]}
        {...signalStroke}
      />
    </AnimatedG>
  );
}

/** The ring that spreads and fades while the bot waits on the operator. */
function Ping({ face, waiting }: SignalProps) {
  const ping = useDerivedValue(() => level(face.get().ping));
  const pingOpacity = useDerivedValue(() => level(face.get().pingOpacity));
  const spread = useAnimatedProps(() => ({
    r: avatarSignals.ping.from + ping.get() * avatarSignals.ping.spread,
    opacity: pingOpacity.get(),
  }));
  return <AnimatedCircle animatedProps={spread} stroke={waiting} {...signalStroke} />;
}

function SoundArc({
  d,
  index,
  face,
  body,
}: SignalProps & { readonly d: string; readonly index: number }) {
  const strength = useDerivedValue(() => level(face.get().arcs[index] ?? 0));
  const shown = useAnimatedProps(() => ({ opacity: strength.get() }));
  return <AnimatedPath d={d} animatedProps={shown} stroke={body} {...signalStroke} />;
}

function ThoughtDot({
  dot,
  index,
  face,
  body,
}: SignalProps & {
  readonly dot: { readonly x: number; readonly y: number; readonly r: number };
  readonly index: number;
}) {
  const share = useDerivedValue(() => level(face.get().dots[index] ?? 0));
  const grow = useAnimatedProps(() => ({ r: dot.r * share.get() }));
  return <AnimatedCircle cx={dot.x} cy={dot.y} animatedProps={grow} fill={body} />;
}

/** The room's members as its avatar draws them, leaving out any bot not known yet. */
export function roomAvatarMembers(
  room: Room,
  bots: ReadonlyMap<BotId, Bot>,
): ReadonlyArray<{ readonly id: string; readonly avatar: Avatar }> {
  return room.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
  });
}

/** Two members overlapping and still: a room, idle, or asleep with the bots while offline. */
export function RoomAvatar({
  members,
  size,
  ground = "background",
}: {
  readonly members: ReadonlyArray<{ readonly id: string; readonly avatar: Avatar }>;
  readonly size: number;
  readonly ground?: AvatarGround;
}) {
  const [back, front] = members;
  const state = useContext(AvatarsAsleep) ? "offline" : "idle";
  const part = Math.round(size * roomAvatarShare);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {back !== undefined && (
        <View style={{ position: "absolute", top: 0, left: 0 }}>
          <BotAvatar avatar={back.avatar} seed={back.id} state={state} size={part} still />
        </View>
      )}
      {front !== undefined && (
        <View style={{ position: "absolute", right: 0, bottom: 0 }}>
          <BotAvatar
            avatar={front.avatar}
            seed={front.id}
            state={state}
            size={part}
            still
            cutout
            ground={ground}
          />
        </View>
      )}
    </View>
  );
}

/** How much of each face in a stack the next one leaves showing. */
const stackStep = 0.62;

/**
 * Faces side by side, each over the one before it, as a header shows a room's
 * members or the two bots of a teammate conversation: up to three, then how
 * many more ("+2"). Still, and hidden from screen readers: the name beside it
 * says who.
 */
export function AvatarStack({
  members,
  size,
  ground = "background",
}: {
  readonly members: ReadonlyArray<{ readonly id: string; readonly avatar: Avatar }>;
  readonly size: number;
  readonly ground?: AvatarGround;
}) {
  const { shown, more } = memberStack(members);
  const state = useContext(AvatarsAsleep) ? "offline" : "idle";
  const overlap = size - Math.round(size * stackStep);
  return (
    <View
      className="flex-row items-center"
      style={{ height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {shown.map((member, index) => (
        <View key={member.id} style={{ marginStart: index === 0 ? 0 : -overlap }}>
          <BotAvatar
            avatar={member.avatar}
            seed={member.id}
            state={state}
            size={size}
            still
            cutout={index > 0}
            ground={ground}
          />
        </View>
      ))}
      {more > 0 && (
        <View
          className="ms-0.5 items-center justify-center rounded-pill bg-muted px-1"
          style={{ height: size, minWidth: size }}
        >
          <Text className="text-2xs font-medium text-muted-foreground">+{more}</Text>
        </View>
      )}
    </View>
  );
}
