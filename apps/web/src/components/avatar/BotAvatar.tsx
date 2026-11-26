// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, Bot, BotId, Room } from "@j3-bots/contracts";
import {
  avatarBusy,
  avatarFace,
  avatarSeed,
  createAvatar,
  pokeAvatar,
  setAvatarState,
  stepAvatar,
  stillFace,
  type AvatarPoke,
  type AvatarState,
} from "@j3-bots/client-runtime/presentation";
import {
  AVATAR_EYE,
  avatarEye,
  avatarFrame,
  avatarShapes,
  avatarSignals,
  avatarViewBox,
  littleFace,
  matrixAttribute,
  resolveAvatar,
  roomAvatarShare,
  stage,
  type AvatarFace,
  type AvatarShapeName,
} from "@j3-bots/design-tokens";
import {
  createContext,
  use,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type Ref,
} from "react";
import { cn } from "../../lib/cn";
import { animate, nudge, reducedMotion } from "./ticker";

/** Whether this client has gone without the server long enough for the bots to sleep (`AvatarConnection`). */
export const AvatarsAsleep = createContext(false);

/** What the avatar's owner can do to it. */
export interface AvatarHandle {
  /** Makes the bot answer: a hop, a nod, a morph, an entrance. */
  readonly poke: (poke: AvatarPoke) => void;
}

export interface BotAvatarProps {
  readonly avatar: Avatar;
  /** What seeds the bot's own manner: its id, so it moves the same everywhere and on every run. */
  readonly seed: string;
  readonly state: AvatarState;
  /** A stalled turn: the avatar holds its state's still form. */
  readonly stalled?: boolean;
  /** In px. It frames well at 24 in lists, 40 in the roster and 96 on a profile. */
  readonly size: number;
  /** Draws the state without motion: for previews of reduced motion, and quiet places. */
  readonly still?: boolean;
  /**
   * Comes in from above as it first shows: it drops into its place, lands and
   * lights its antenna, after `delay` ms when one is given. A `still` avatar
   * moves for its entrance and then rests.
   */
  readonly entrance?: boolean | { readonly delay: number };
  /**
   * Draws a band of what it sits on (`--avatar-cutout`, the page's background
   * unless set) around the body, to stand clear of what it overlaps. A status
   * light always has one of its own.
   */
  readonly cutout?: boolean;
  /** The bot's name and state for assistive technology; omit when text next to it says the same. */
  readonly label?: string;
  readonly className?: string;
  readonly ref?: Ref<AvatarHandle>;
}

/** The part of the avatar's 100-unit box an avatar's SVG frames, as its `viewBox`. */
export const AVATAR_VIEW_BOX = `${avatarViewBox.x} ${avatarViewBox.y} ${avatarViewBox.size} ${avatarViewBox.size}`;

/** A body's rim, its stalk and its tip: the body's color, unless a little one sets its own. */
const RIM = "var(--avatar-rim, var(--avatar-body))";

/** The SVG elements a frame writes to. */
interface Parts {
  readonly body: SVGGElement;
  readonly eye: SVGGElement;
  readonly lens: SVGGElement;
  readonly pupil: SVGCircleElement;
  readonly glint: SVGCircleElement;
  readonly cheek: SVGPathElement;
  readonly upperLid: SVGPathElement;
  readonly lowerLid: SVGPathElement;
  readonly arc: SVGPathElement;
  readonly mouth: SVGEllipseElement;
  readonly stalk: SVGPathElement;
  readonly light: SVGCircleElement;
  readonly halo: SVGCircleElement;
  readonly lightCut: SVGCircleElement;
  readonly signal: SVGGElement;
  readonly ring: SVGCircleElement;
  readonly ping: SVGCircleElement;
  readonly arc0: SVGPathElement;
  readonly arc1: SVGPathElement;
  readonly dot0: SVGCircleElement;
  readonly dot1: SVGCircleElement;
}

function partsOf(svg: SVGSVGElement): Parts {
  const part = <T extends Element>(name: string, type: new () => T): T => {
    const found = svg.querySelector(`[data-part="${name}"]`);
    if (!(found instanceof type)) throw new Error(`An avatar lacks its ${name}.`);
    return found;
  };
  return {
    body: part("body", SVGGElement),
    eye: part("eye", SVGGElement),
    lens: part("lens", SVGGElement),
    pupil: part("pupil", SVGCircleElement),
    glint: part("glint", SVGCircleElement),
    cheek: part("cheek", SVGPathElement),
    upperLid: part("upper-lid", SVGPathElement),
    lowerLid: part("lower-lid", SVGPathElement),
    arc: part("arc", SVGPathElement),
    mouth: part("mouth", SVGEllipseElement),
    stalk: part("stalk", SVGPathElement),
    light: part("light", SVGCircleElement),
    halo: part("halo", SVGCircleElement),
    lightCut: part("light-cut", SVGCircleElement),
    signal: part("signal", SVGGElement),
    ring: part("ring", SVGCircleElement),
    ping: part("ping", SVGCircleElement),
    arc0: part("arc-0", SVGPathElement),
    arc1: part("arc-1", SVGPathElement),
    dot0: part("dot-0", SVGCircleElement),
    dot1: part("dot-1", SVGCircleElement),
  };
}

const LIGHT = {
  body: RIM,
  waiting: "var(--waiting)",
  blocked: "var(--blocked)",
  foreground: "var(--foreground)",
} as const satisfies Record<AvatarFace["light"], string>;

const n = (value: number) => String(Math.round(value * 100) / 100);

/**
 * Draws faces into one avatar's SVG (`AvatarParts`), writing only the
 * attributes that changed since the last frame; `little` for one of a bot's
 * little ones.
 */
export function painter(
  svg: SVGSVGElement,
  size: () => number,
  shape: () => AvatarShapeName,
  little = false,
) {
  const parts = partsOf(svg);
  const written = new WeakMap<Element, Map<string, string>>();
  const set = (element: Element, name: string, value: string) => {
    let attributes = written.get(element);
    if (attributes === undefined) {
      attributes = new Map();
      written.set(element, attributes);
    }
    if (attributes.get(name) === value) return;
    attributes.set(name, value);
    element.setAttribute(name, value);
  };
  return (face: AvatarFace) => {
    const f = avatarFrame(shape(), face, size(), little);
    const p = parts;
    set(svg, "data-signal", face.signal ?? "none");
    set(svg, "data-asleep", face.asleep ? "true" : "false");
    set(p.body, "transform", matrixAttribute(f.body));
    set(p.eye, "transform", matrixAttribute(f.eye));
    set(p.lens, "visibility", f.open ? "visible" : "hidden");
    set(p.pupil, "cx", n(f.pupil.x));
    set(p.pupil, "cy", n(f.pupil.y));
    set(p.pupil, "r", n(f.pupil.r));
    set(p.glint, "visibility", f.glint === null ? "hidden" : "visible");
    if (f.glint !== null) {
      set(p.glint, "cx", n(f.glint.x));
      set(p.glint, "cy", n(f.glint.y));
      set(p.glint, "r", n(f.glint.r));
    }
    set(p.cheek, "d", f.cheek);
    set(p.upperLid, "d", f.upperLid);
    set(p.lowerLid, "d", f.lowerLid);
    set(p.arc, "d", f.arc);
    set(p.arc, "opacity", n(f.arcOpacity));
    set(p.arc, "stroke-width", n(f.arcWidth));
    set(p.mouth, "cx", n(f.mouth.cx));
    set(p.mouth, "cy", n(f.mouth.cy));
    set(p.mouth, "ry", n(f.mouth.ry));
    set(p.stalk, "d", f.stalk);
    set(p.stalk, "stroke-width", n(f.stalkWidth));
    set(p.light, "cx", n(f.light.x));
    set(p.light, "cy", n(f.light.y));
    set(p.light, "r", n(f.light.r));
    set(p.light, "fill", LIGHT[face.light]);
    set(p.halo, "visibility", f.haloOpacity > 0 ? "visible" : "hidden");
    if (f.haloOpacity > 0) {
      set(p.halo, "cx", n(f.halo.x));
      set(p.halo, "cy", n(f.halo.y));
      set(p.halo, "r", n(f.halo.r));
      set(p.halo, "opacity", n(f.haloOpacity));
      set(p.halo, "stroke", LIGHT[face.light]);
    }
    set(p.lightCut, "cx", n(f.light.x));
    set(p.lightCut, "cy", n(f.light.y));
    set(p.lightCut, "r", n(f.lightCut));
    set(p.signal, "transform", matrixAttribute(f.signal));
    switch (face.signal) {
      case "ring":
        set(p.ring, "transform", matrixAttribute(f.ring));
        break;
      case "ping":
        set(p.ping, "r", n(avatarSignals.ping.from + face.ping * avatarSignals.ping.spread));
        set(p.ping, "opacity", n(face.pingOpacity));
        break;
      case "arcs":
        set(p.arc0, "opacity", n(face.arcs[0]));
        set(p.arc1, "opacity", n(face.arcs[1]));
        break;
      case "dots":
        set(p.dot0, "r", n(avatarSignals.dots[0].r * face.dots[0]));
        set(p.dot1, "r", n(avatarSignals.dots[1].r * face.dots[1]));
        break;
      case null:
        break;
    }
  };
}

/** The props a mounted avatar follows. */
interface Live {
  readonly state: AvatarState;
  readonly stalled: boolean;
  readonly still: boolean;
  readonly shape: AvatarShapeName;
}

/** What a mounted avatar takes from its component. */
interface Controller {
  /** New props: a new state turns the sim, which eases into its pose; a still avatar redraws. */
  readonly update: (live: Live) => void;
  readonly poke: (poke: AvatarPoke) => void;
}

/** Under this size, in px, an avatar is at list size: its entrance comes from just above its row. */
const LIST_SIZE = 44;
/** How long an avatar takes to show as its entrance begins, in ms: it fades in as it starts to fall. */
const ENTRANCE_FADE = 140;

/**
 * Starts the avatar drawn in `svg` on the shared frame loop, with its own sim
 * from `seed`. Returns what drives it and what takes it off the loop.
 */
function mountAvatar(
  svg: SVGSVGElement,
  seed: number,
  size: number,
  initial: Live,
  entrance: number | null,
): { readonly controller: Controller; readonly stop: () => void } {
  let live = initial;
  let sim = createAvatar(seed, live.state);
  const draw = painter(
    svg,
    () => size,
    () => live.shape,
  );
  // Asleep is a resting state: an offline avatar holds its still form, which spares
  // the page redrawing its washed-out filter every frame. A still avatar moves only
  // while it is in the middle of something it was asked for, as its entrance.
  const moving = () =>
    !live.stalled &&
    live.state !== "offline" &&
    !reducedMotion() &&
    (!live.still || avatarBusy(sim));
  const drawStill = () => draw(stillFace(live.state, sim.traits, live.stalled));
  const running = animate(
    {
      size,
      moving,
      measure: () => svg.getBoundingClientRect(),
      step: (dt, near) => {
        sim = stepAvatar(sim, dt, near);
        draw(avatarFace(sim));
      },
      still: drawStill,
    },
    svg,
  );
  const poke = (how: AvatarPoke) => {
    if (live.stalled || live.state === "offline" || reducedMotion()) return;
    // A still avatar is in a quiet place: it comes in when it is new, and answers nothing else.
    if (live.still && how !== "arrive" && how !== "drop") return;
    sim = pokeAvatar(sim, how);
    nudge();
  };
  let waiting = 0;
  let fade: Animation | null = null;
  if (entrance !== null && !reducedMotion()) {
    const enter = () => {
      waiting = 0;
      poke(size < LIST_SIZE ? "drop" : "arrive");
      // Its first frame, in the air, at once: it never shows standing in its place first.
      draw(avatarFace(sim));
      fade = svg.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ENTRANCE_FADE,
        easing: "linear",
      });
    };
    if (entrance > 0) {
      // Until its turn comes it is not there.
      fade = svg.animate([{ opacity: 0 }, { opacity: 0 }], {
        duration: entrance,
        fill: "forwards",
      });
      waiting = window.setTimeout(() => {
        fade?.cancel();
        enter();
      }, entrance);
    } else enter();
  }
  return {
    stop: () => {
      window.clearTimeout(waiting);
      fade?.cancel();
      running.stop();
    },
    controller: {
      update: (next) => {
        live = next;
        sim = setAvatarState(sim, next.state);
        if (moving()) running.restate();
        else drawStill();
      },
      poke,
    },
  };
}

/**
 * The parts of an avatar a `painter` draws faces into, inside an SVG framed by
 * `AVATAR_VIEW_BOX`: the bot's own, or, `little`, one of its little ones',
 * whose body is the bot's silhouette with a wider rim. The body is filled with
 * `--avatar-body`; its rim, its stalk and its tip take `--avatar-rim`, which is
 * the body's color unless set.
 */
export function AvatarParts({
  shape,
  cutout = false,
  little = false,
}: {
  readonly shape: AvatarShapeName;
  readonly cutout?: boolean;
  readonly little?: boolean;
}) {
  const body = avatarShapes[shape];
  return (
    <g data-part="body">
      {cutout && (
        <path
          d={body.path}
          fill="none"
          stroke="var(--avatar-cutout, var(--background))"
          strokeWidth={body.outline + 12}
          strokeLinejoin="round"
        />
      )}
      <path data-part="stalk" fill="none" stroke={RIM} strokeLinecap="round" />
      <path
        d={body.path}
        fill="var(--avatar-body)"
        stroke={RIM}
        strokeWidth={body.outline + (little ? littleFace.outline : 0)}
        strokeLinejoin="round"
      />
      <g data-part="eye">
        <g data-part="lens">
          <circle r={AVATAR_EYE} fill={avatarEye.lens} />
          <circle data-part="pupil" fill={avatarEye.pupil} />
          <circle data-part="glint" fill={avatarEye.lens} opacity={0.92} />
          <path data-part="cheek" fill="var(--avatar-body)" />
          <path data-part="upper-lid" fill="var(--avatar-body)" />
          <path data-part="lower-lid" fill="var(--avatar-body)" />
        </g>
        <path data-part="arc" fill="none" stroke={avatarEye.lens} strokeLinecap="round" />
      </g>
      <ellipse data-part="mouth" rx={5.2} fill={avatarEye.pupil} />
      <circle data-part="light-cut" fill="var(--avatar-cutout, var(--background))" />
      <g data-part="signal" fill="none" strokeWidth={avatarSignals.stroke} strokeLinecap="round">
        <g className="avatar-signal" data-signal-of="ring">
          <circle
            data-part="ring"
            r={avatarSignals.ring.r}
            stroke="var(--avatar-body)"
            strokeDasharray={avatarSignals.ring.dash.join(" ")}
          />
        </g>
        <g className="avatar-signal" data-signal-of="ping">
          <circle data-part="ping" stroke="var(--waiting)" />
        </g>
        <g className="avatar-signal" data-signal-of="arcs" stroke="var(--avatar-body)">
          {avatarSignals.arcs.map((d, i) => (
            <path key={d} data-part={`arc-${i}`} d={d} />
          ))}
        </g>
        <g className="avatar-signal" data-signal-of="dots" fill="var(--avatar-body)">
          {avatarSignals.dots.map((dot, i) => (
            <circle
              key={`${dot.x} ${dot.y}`}
              data-part={`dot-${i}`}
              cx={dot.x}
              cy={dot.y}
              r={dot.r}
            />
          ))}
        </g>
      </g>
      <circle data-part="halo" fill="none" strokeWidth={1.6} visibility="hidden" />
      <circle data-part="light" />
    </g>
  );
}

/**
 * A bot's face: its silhouette in its color, one lens eye, and an antenna
 * whose tip is the status light. It lives on the page's shared frame loop
 * (`ticker.ts`): it blinks, glances, breathes and moves the way its state
 * does, on its own seeded clock. Its eye follows the pointer from close by,
 * it goes down under a press and springs back, and it answers a tap. Off
 * screen, under reduced motion, when `still`, asleep, or while its turn is
 * stalled, it holds its state's still form.
 */
export function BotAvatar({
  avatar,
  seed,
  state,
  stalled = false,
  size,
  still = false,
  entrance = false,
  cutout = false,
  label,
  className,
  ref,
}: BotAvatarProps) {
  const { shape, color } = resolveAvatar(avatar);
  const svgRef = useRef<SVGSVGElement>(null);
  const controller = useRef<Controller | null>(null);
  const latest = useRef<Live>({ state, stalled, still, shape });
  const seedNumber = avatarSeed(seed);

  useEffect(() => {
    latest.current = { state, stalled, still, shape };
    controller.current?.update(latest.current);
  }, [state, stalled, still, shape]);

  // One sim per bot: a new seed or size starts it again. Its entrance is its first mount's alone.
  const entranceAt = useRef(entrance === false ? null : entrance === true ? 0 : entrance.delay);
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const mounted = mountAvatar(svg, seedNumber, size, latest.current, entranceAt.current);
    // Spent once this mount has outlived the tick it was made in: a mount React makes only to
    // take down again at once, as its development checks do, leaves the entrance for the next.
    const spent = window.setTimeout(() => {
      entranceAt.current = null;
    }, 0);
    controller.current = mounted.controller;
    return () => {
      window.clearTimeout(spent);
      mounted.stop();
      controller.current = null;
    };
  }, [seedNumber, size]);

  useImperativeHandle(ref, () => ({ poke: (poke) => controller.current?.poke(poke) }), []);

  const style = { "--avatar-body": `var(--bot-${color})` } as CSSProperties;
  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={AVATAR_VIEW_BOX}
      className={cn("avatar shrink-0 overflow-visible", className)}
      style={style}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") controller.current?.poke("hover");
      }}
      onPointerDown={(event) => {
        if (event.button === 0) controller.current?.poke("press");
      }}
      onPointerUp={() => controller.current?.poke("tap")}
      onPointerLeave={() => controller.current?.poke("release")}
      onPointerCancel={() => controller.current?.poke("release")}
    >
      <AvatarParts shape={shape} cutout={cutout} />
    </svg>
  );
}

interface RoomAvatarMember {
  readonly id: string;
  readonly avatar: Avatar;
}

/** The room's members as its avatar draws them, leaving out any bot not known yet. */
export function roomAvatarMembers(
  room: Room,
  bots: ReadonlyMap<BotId, Bot>,
): ReadonlyArray<RoomAvatarMember> {
  return room.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot ? [{ id: bot.id, avatar: bot.profile.avatar }] : [];
  });
}

/**
 * Two members overlapping and still: a room, idle, or asleep with the bots
 * while offline. With `entrance`, its members come in one after the other.
 */
export function RoomAvatar({
  members,
  size,
  entrance = false,
}: {
  readonly members: ReadonlyArray<RoomAvatarMember>;
  readonly size: number;
  readonly entrance?: boolean;
}) {
  const [back, front] = members;
  const part = Math.round(size * roomAvatarShare);
  const state = use(AvatarsAsleep) ? "offline" : "idle";
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {back && (
        <span className="absolute top-0 left-0">
          <BotAvatar
            avatar={back.avatar}
            seed={back.id}
            state={state}
            size={part}
            still
            entrance={entrance}
          />
        </span>
      )}
      {front && (
        <span className="absolute right-0 bottom-0">
          <BotAvatar
            avatar={front.avatar}
            seed={front.id}
            state={state}
            size={part}
            still
            cutout
            entrance={entrance && { delay: stage.stagger }}
          />
        </span>
      )}
    </span>
  );
}
