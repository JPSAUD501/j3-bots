// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  alongGlide,
  glideBend,
  pointerAside,
  type GlideSide,
} from "@j3-bots/client-runtime/presentation";
import type { Bot } from "@j3-bots/contracts";
import { eases, motion, pointer, press, resolveAvatar, springs } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar";
import { useReducedMotion } from "../onboarding/motion";

/** What a pointer shows of its bot: its face and name. */
export type PointerBot = Pick<Bot, "id"> & {
  readonly profile: Pick<Bot["profile"], "name" | "avatar">;
};

/** How many points a glide's curve is drawn through. */
const GLIDE_STEPS = 16;

/**
 * A bot's own pointer over the page, as editors written by many hands show
 * who is where: a rounded arrow in the bot's color, edged in white, that
 * never turns, and below it a tag with the bot's face and name (`tagged`).
 * `at` is where it points, as shares of the page's width and height.
 *
 * It fades in where it first points and glides on a gentle curve to each next
 * spot, taking `glide` ms, each curve bending to the other side. Thinking
 * before it acts, it bobs. A click to answer (`clicked`, the click's
 * sequence) squashes the arrow, rings where it landed and makes the face
 * smile; `onAnswered` says so, for the click to be answered once. While the person
 * holds the tab (`held`) it steps aside and fades, its face surprised, then
 * waiting, with its tag open. Under reduced motion it moves at once, and
 * neither bobs nor squashes.
 */
export function BotCursor({
  bot,
  at,
  glide = motion.glide,
  clicked,
  onAnswered,
  tagged,
  held = false,
  thinking = false,
}: {
  readonly bot: PointerBot;
  readonly at: { readonly x: number; readonly y: number };
  readonly glide?: number;
  readonly clicked: number | null;
  /** The click `clicked` was answered: the next time this pointer shows, it is not answered again. */
  readonly onAnswered?: (clicked: number) => void;
  readonly tagged: boolean;
  readonly held?: boolean;
  readonly thinking?: boolean;
}) {
  const ink = `var(--bot-${resolveAvatar(bot.profile.avatar).color})`;
  const reduced = useReducedMotion();
  const placed = useRef<HTMLSpanElement>(null);
  const bobbing = useRef<HTMLSpanElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const face = useRef<AvatarHandle>(null);

  // The glide: the curve from where it is, mid-glide too, to where it points, through the page's own shape.
  const { x, y } = at;
  const glided = useRef<{ x: number; y: number; side: GlideSide; run: Animation | null }>({
    x,
    y,
    side: 1,
    run: null,
  });
  useLayoutEffect(() => {
    const element = placed.current;
    const box = element?.parentElement;
    const last = glided.current;
    const from = { x: last.x, y: last.y };
    last.x = x;
    last.y = y;
    if (element == null || box == null || (from.x === x && from.y === y)) return;
    // Where a glide under way has it now, read before it stops: after, it reads where it goes.
    const midway =
      last.run?.playState === "running" ? { x: element.offsetLeft, y: element.offsetTop } : null;
    last.run?.cancel();
    last.run = null;
    if (reduced || glide === 0 || box.clientWidth === 0 || box.clientHeight === 0) return;
    const size = { width: box.clientWidth, height: box.clientHeight };
    const start = midway ?? { x: from.x * size.width, y: from.y * size.height };
    const end = { x: x * size.width, y: y * size.height };
    last.side = last.side === 1 ? -1 : 1;
    const bend = glideBend(start, end, last.side);
    const points = Array.from({ length: GLIDE_STEPS + 1 }, (_, step) => {
      const point = alongGlide(start, bend, end, step / GLIDE_STEPS);
      return { left: `${(point.x / size.width) * 100}%`, top: `${(point.y / size.height) * 100}%` };
    });
    last.run = element.animate(points, { duration: glide, easing: eases.glide });
  }, [x, y, glide, reduced]);

  // Thinking: a small bob up and back.
  useEffect(() => {
    if (!thinking || reduced) return;
    const run = bobbing.current?.animate(
      [
        { transform: "translateY(0)" },
        { transform: `translateY(${-pointer.bob}px)` },
        { transform: "translateY(0)" },
      ],
      { duration: pointer.bobPeriod, easing: "ease-in-out", iterations: Infinity },
    );
    return () => run?.cancel();
  }, [thinking, reduced]);

  // A click: the arrow goes down from its point and springs back, a ring spreads, the face smiles.
  const clickedAt = useEffectEvent((click: number) => {
    onAnswered?.(click);
    face.current?.poke("smile");
    ring.current?.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: "scale(0.3)", opacity: 1 },
            { transform: "scale(1.6)", opacity: 0 },
          ],
      { duration: pointer.ring, easing: eases.out },
    );
    if (reduced) return;
    const total = press.duration + springs.pop.duration;
    arrow.current?.animate(
      [
        { transform: "scale(1)", easing: eases.out },
        {
          transform: `scale(${pointer.pressScale})`,
          offset: press.duration / total,
          easing: springs.pop.easing,
        },
        { transform: "scale(1)" },
      ],
      { duration: total },
    );
  });
  useEffect(() => {
    if (clicked !== null) clickedAt(clicked);
  }, [clicked]);

  // The person takes the tab: surprised a moment, then waiting until it is given back.
  const [waits, setWaits] = useState(false);
  if (!held && waits) setWaits(false);
  useEffect(() => {
    if (!held) return;
    face.current?.poke("hover");
    const timer = window.setTimeout(() => setWaits(true), pointer.surprise);
    return () => window.clearTimeout(timer);
  }, [held]);

  const open = tagged || held;
  const aside = held ? pointerAside(at) : { x: 0, y: 0 };
  const stepping = reduced ? 0 : motion.glide;
  return (
    <span
      ref={placed}
      aria-hidden
      className="fade-in pointer-events-none absolute"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        opacity: held ? pointer.heldOpacity : 1,
        transform: `translate(${aside.x}px, ${aside.y}px)`,
        transition: `transform ${stepping}ms ${eases.glide}, opacity var(--duration-state) ${eases.out}`,
      }}
    >
      <span ref={bobbing} className="block">
        <span
          ref={ring}
          className="absolute -top-3 -left-3 size-6 rounded-pill border-2 opacity-0"
          style={{ borderColor: ink }}
        />
        <span ref={arrow} className="block origin-top-left">
          <svg
            width={pointer.box}
            height={pointer.box}
            viewBox={`0 0 ${pointer.box} ${pointer.box}`}
            className="absolute block overflow-visible"
            style={{ left: -pointer.tip.x, top: -pointer.tip.y, filter: pointer.arrowShadow }}
          >
            <path
              d={pointer.arrow}
              fill={ink}
              stroke={pointer.light}
              strokeWidth={pointer.outline}
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span
          className="absolute flex origin-top-left items-center gap-1 rounded-pill ps-0.5 pe-2 text-2xs font-semibold whitespace-nowrap"
          style={{
            left: pointer.tagAt.x,
            top: pointer.tagAt.y,
            height: pointer.tagHeight,
            background: pointer.light,
            color: pointer.ink,
            border: `${pointer.tagEdge}px solid ${ink}`,
            boxShadow: pointer.tagShadow,
            opacity: open ? 1 : 0,
            transform: open || reduced ? "none" : `scale(${pointer.tagFrom})`,
            transition: `opacity var(--duration-state) ${eases.out}, transform var(--duration-pop) var(--ease-pop)`,
          }}
        >
          <BotAvatar
            ref={face}
            avatar={bot.profile.avatar}
            seed={bot.id}
            state={held && waits ? "waiting" : "idle"}
            size={pointer.face}
          />
          {bot.profile.name}
        </span>
      </span>
    </span>
  );
}
