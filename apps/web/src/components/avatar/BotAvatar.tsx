// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, Bot, BotId, Room } from "@j3-bots/contracts";
import {
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
  matrixAttribute,
  resolveAvatar,
  roomAvatarShare,
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
  /** Makes the bot answer with a small move: a hop, a nod, a morph. */
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

const VIEW_BOX = `${avatarViewBox.x} ${avatarViewBox.y} ${avatarViewBox.size} ${avatarViewBox.size}`;

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
  body: "var(--avatar-body)",
  waiting: "var(--waiting)",
  blocked: "var(--blocked)",
  foreground: "var(--foreground)",
} as const satisfies Record<AvatarFace["light"], string>;

const n = (value: number) => String(Math.round(value * 100) / 100);

/**
 * Draws faces into one avatar's SVG, writing only the attributes that changed
 * since the last frame.
 */
function painter(svg: SVGSVGElement, size: () => number, shape: () => AvatarShapeName) {
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
    const f = avatarFrame(shape(), face, size());
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

/**
 * Starts the avatar drawn in `svg` on the shared frame loop, with its own sim
 * from `seed`. Returns what drives it and what takes it off the loop.
 */
function mountAvatar(
  svg: SVGSVGElement,
  seed: number,
  size: number,
  initial: Live,
): { readonly controller: Controller; readonly stop: () => void } {
  let live = initial;
  let sim = createAvatar(seed, live.state);
  const draw = painter(
    svg,
    () => size,
    () => live.shape,
  );
  // Asleep is a resting state: an offline avatar holds its still form, which spares
  // the page redrawing its washed-out filter every frame.
  const moving = () => !live.still && !live.stalled && live.state !== "offline" && !reducedMotion();
  const drawStill = () => draw(stillFace(live.state, sim.traits, live.stalled));
  const running = animate(
    {
      size,
      moving,
      measure: () => svg.getBoundingClientRect(),
      step: (dt, gaze) => {
        sim = stepAvatar(sim, dt, gaze);
        draw(avatarFace(sim));
      },
      still: drawStill,
    },
    svg,
  );
  return {
    stop: running.stop,
    controller: {
      update: (next) => {
        live = next;
        sim = setAvatarState(sim, next.state);
        if (moving()) running.restate();
        else drawStill();
      },
      poke: (poke) => {
        if (!moving()) return;
        sim = pokeAvatar(sim, poke);
        nudge();
      },
    },
  };
}

/**
 * A bot's face: its silhouette in its color, one lens eye, and an antenna
 * whose tip is the status light. It lives on the page's shared frame loop
 * (`ticker.ts`): it blinks, glances, breathes and moves the way its state
 * does, on its own seeded clock, and its eye follows the pointer on desktop.
 * Off screen, under reduced motion, when `still`, asleep, or while its turn
 * is stalled, it holds its state's still form.
 */
export function BotAvatar({
  avatar,
  seed,
  state,
  stalled = false,
  size,
  still = false,
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

  // One sim per bot: a new seed or size starts it again.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const mounted = mountAvatar(svg, seedNumber, size, latest.current);
    controller.current = mounted.controller;
    return () => {
      mounted.stop();
      controller.current = null;
    };
  }, [seedNumber, size]);

  useImperativeHandle(ref, () => ({ poke: (poke) => controller.current?.poke(poke) }), []);

  const style = { "--avatar-body": `var(--bot-${color})` } as CSSProperties;
  const body = avatarShapes[shape];
  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      className={cn("avatar shrink-0 overflow-visible", className)}
      style={style}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") controller.current?.poke("hover");
      }}
      onPointerDown={() => controller.current?.poke("press")}
    >
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
        <path data-part="stalk" fill="none" stroke="var(--avatar-body)" strokeLinecap="round" />
        <path
          d={body.path}
          fill="var(--avatar-body)"
          stroke="var(--avatar-body)"
          strokeWidth={body.outline}
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
        <circle data-part="light" />
      </g>
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

/** Two members overlapping and still: a room, idle, or asleep with the bots while offline. */
export function RoomAvatar({
  members,
  size,
}: {
  readonly members: ReadonlyArray<RoomAvatarMember>;
  readonly size: number;
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
          <BotAvatar avatar={back.avatar} seed={back.id} state={state} size={part} still />
        </span>
      )}
      {front && (
        <span className="absolute right-0 bottom-0">
          <BotAvatar avatar={front.avatar} seed={front.id} state={state} size={part} still cutout />
        </span>
      )}
    </span>
  );
}
