// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import {
  arrivingAt,
  moveResponse,
  pointerAside,
  pointerBounds,
  type PointerMotion,
  restingAt,
  startMove,
  stepPointer,
  tagCloseAfter,
  tagOffset,
  type TagSide,
} from "@j3-bots/client-runtime/presentation";
import type { Bot } from "@j3-bots/contracts";
import { eases, pointer, press, resolveAvatar, springs } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar";
import { drive } from "../components/avatar/ticker";
import { type Sprung, sprung } from "../lib/sprung";
import { useReducedMotion } from "../onboarding/motion";
import type { Size } from "./input";

/** What a pointer shows of its bot: its face and name. */
export type PointerBot = Pick<Bot, "id"> & {
  readonly profile: Pick<Bot["profile"], "name" | "avatar">;
};

/** Where a bot points, in the page's px, and which of its points this is. */
export type PointerPoint = Pick<BrowserCursor, "x" | "y" | "action" | "sequence">;

/** A tag's width before it is measured, in px. */
export const TAG_WIDTH_GUESS = 80;

/** One period of the thinking drift, in seconds: as long as a page's drawing lets it run per point. */
const DRIFT_PERIOD = pointer.drift.period / 1000;

/**
 * A bot's own pointer over the page, as editors written by many hands show
 * who is where: a rounded arrow in the bot's color, edged in white, and
 * beside it a tag with the bot's face and name. `point` is where it points,
 * in the px of a page of `page`'s size.
 *
 * It moves as `pointerMotion` in the client runtime says: it comes in from
 * behind its arrow where it first points, travels to each next point on the
 * path that suits the way it already heads, and leans into the move on its
 * tip, never more than `pointer.lean.most`; the tag and the ring never turn.
 * A click (`clicked`, the click's sequence, while it is still to answer)
 * plays as the pointer arrives: the arrow presses, a ring spreads and the
 * face smiles; `onAnswered` says so, for the click to be answered once. The
 * tag opens on each point and closes a moment after it arrives, on `side`,
 * sliding there. Thinking before it acts, the tip drifts in a small figure
 * eight. While the person holds the tab (`held`) it moves aside and fades,
 * its face surprised, then waiting, with its tag open. Under reduced motion
 * it is where it points at once, and neither leans, drifts nor presses.
 * `still`, it is drawn in a page, whose every change is a new picture for
 * whoever watches it: it drifts one period per point at most, and its face
 * holds still. A pointer at rest draws nothing.
 */
export function BotCursor({
  bot,
  point,
  page,
  side,
  layer,
  clicked,
  onAnswered,
  onTagWidth,
  held = false,
  thinking = false,
  still = false,
}: {
  readonly bot: PointerBot;
  readonly point: PointerPoint;
  readonly page: Size;
  readonly side: TagSide;
  /** Drawn over the pointers of lower layers: the bot that pointed last is on top. */
  readonly layer: number;
  readonly clicked: number | null;
  /** The click `clicked` was answered: the next time this pointer shows, it is not answered again. */
  readonly onAnswered?: (clicked: number) => void;
  /** The tag's width, in px, each time it changes. */
  readonly onTagWidth?: (width: number) => void;
  readonly held?: boolean;
  readonly thinking?: boolean;
  readonly still?: boolean;
}) {
  const ink = `var(--bot-${resolveAvatar(bot.profile.avatar).color})`;
  const reduced = useReducedMotion();
  const placed = useRef<HTMLSpanElement>(null);
  const leaning = useRef<HTMLSpanElement>(null);
  const pressing = useRef<HTMLSpanElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const bloom = useRef<HTMLSpanElement>(null);
  const tagPlace = useRef<HTMLSpanElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const face = useRef<AvatarHandle>(null);

  // The motion, stepped on the page's frame loop while anything of it moves.
  const motion = useRef<PointerMotion | null>(null);
  const drawn = useRef({ placed: "", lean: "" });
  /** Whether the motion is on the frame loop, and what takes it off. */
  const running = useRef(false);
  const stopRunning = useRef<() => void>(() => {});
  /** The click to play when the pointer arrives; a newer point drops it. */
  const pending = useRef<number | null>(null);
  // The tag opens on each point and as the person takes the tab, and closes on a timer after.
  const [tagged, setTagged] = useState(true);
  const [taggedFor, setTaggedFor] = useState({ point, held });
  if (taggedFor.point !== point || taggedFor.held !== held) {
    setTaggedFor({ point, held });
    if (taggedFor.point !== point || held) setTagged(true);
  }
  const closing = useRef<number | undefined>(undefined);

  const draw = useEffectEvent((now: PointerMotion, size: Size) => {
    const at =
      size.width > 0 && size.height > 0
        ? `translate(${(now.tipX / size.width) * 100}%, ${(now.tipY / size.height) * 100}%)`
        : "";
    // An upright arrow writes no turn at all.
    const lean = now.lean === 0 ? "" : `rotate(${now.lean.toFixed(3)}deg)`;
    if (at !== drawn.current.placed && placed.current !== null) {
      drawn.current.placed = at;
      placed.current.style.transform = at;
    }
    if (lean !== drawn.current.lean && leaning.current !== null) {
      drawn.current.lean = lean;
      leaning.current.style.transform = lean;
    }
  });

  const closeTagIn = (ms: number) => {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setTagged(false), ms);
  };

  // A click, as the pointer lands: the arrow goes down from its tip and springs back, a ring spreads, the face smiles.
  const playClick = useEffectEvent((click: number) => {
    onAnswered?.(click);
    face.current?.poke("smile");
    ring.current?.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: "scale(0.3)", opacity: 1 },
            { transform: `scale(${pointer.ringTo})`, opacity: 0 },
          ],
      { duration: pointer.ring, easing: eases.out },
    );
    bloom.current?.animate(
      reduced
        ? [{ opacity: pointer.bloomOpacity }, { opacity: 0 }]
        : [
            { transform: "scale(0.6)", opacity: pointer.bloomOpacity },
            { transform: "scale(1.4)", opacity: 0 },
          ],
      { duration: pointer.ring, easing: eases.out },
    );
    if (reduced) return;
    const total = press.duration + springs.pop.duration;
    pressing.current?.animate(
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

  const arrived = useEffectEvent(() => {
    const click = pending.current;
    pending.current = null;
    if (click !== null) playClick(click);
    if (!held) closeTagIn(tagCloseAfter(click === null ? "move" : "click"));
  });

  const frame = useEffectEvent((seconds: number): boolean => {
    const now = motion.current;
    if (now === null) return false;
    const step = stepPointer(now, seconds, {
      thinking: thinking && !held,
      driftBudget: still ? DRIFT_PERIOD : Number.POSITIVE_INFINITY,
      lean: !reduced,
      reduced,
    });
    motion.current = step.motion;
    draw(step.motion, page);
    if (step.arrived) arrived();
    return !step.resting;
  });

  /** Puts the motion on the frame loop, unless it is there already. */
  const run = useEffectEvent(() => {
    if (running.current) return;
    running.current = true;
    // Under reduced motion the loop steps it once, there and then, to rest.
    stopRunning.current = drive((seconds) => {
      const more = frame(seconds);
      if (!more) running.current = false;
      return more;
    });
  });
  useEffect(
    () => () => {
      stopRunning.current();
      running.current = false;
      window.clearTimeout(closing.current);
    },
    [],
  );
  // A page of another size puts the same point elsewhere in the drawing: drawn again, at rest too.
  const { width, height } = page;
  useLayoutEffect(() => {
    if (motion.current !== null) draw(motion.current, { width, height });
  }, [width, height]);

  // Each point: from where it is on its path, mid-move too, or in from behind its arrow where it first points.
  const pointed = useEffectEvent((to: PointerPoint) => {
    const at = { x: to.x, y: to.y };
    const bounds = pointerBounds(page);
    const now = motion.current;
    if (now === null) {
      motion.current = reduced ? startMove(restingAt(at), at, 0, bounds) : arrivingAt(at, bounds);
      draw(motion.current, page);
    } else {
      const share =
        Math.hypot(at.x - now.x, at.y - now.y) / Math.max(1, Math.hypot(page.width, page.height));
      motion.current = startMove(now, at, moveResponse(share), bounds);
    }
    pending.current = to.action === "click" && clicked === to.sequence ? to.sequence : null;
    window.clearTimeout(closing.current);
    run();
  });
  useLayoutEffect(() => pointed(point), [point]);

  // The person takes the tab: it moves aside, surprised a moment, then waiting until it is given back,
  // when it fades back where it waited and goes on from there.
  const [waits, setWaits] = useState(false);
  if (!held && waits) setWaits(false);
  const wasHeld = useRef(held);
  const holding = useEffectEvent((now: boolean) => {
    if (now === wasHeld.current) return;
    wasHeld.current = now;
    const motionNow = motion.current;
    if (!now) {
      closeTagIn(pointer.tagLinger);
      return;
    }
    face.current?.poke("hover");
    window.clearTimeout(closing.current);
    if (motionNow === null || page.width <= 0 || page.height <= 0) return;
    const target = motionNow.moving
      ? { x: motionNow.path.x1, y: motionNow.path.y1 }
      : { x: motionNow.x, y: motionNow.y };
    const aside = pointerAside({ x: target.x / page.width, y: target.y / page.height });
    pending.current = null;
    motion.current = startMove(
      motionNow,
      { x: target.x + aside.x, y: target.y + aside.y },
      pointer.asideResponse,
      pointerBounds(page),
    );
    run();
  });
  useEffect(() => {
    holding(held);
    if (!held) return;
    const timer = window.setTimeout(() => setWaits(true), pointer.surprise);
    return () => window.clearTimeout(timer);
  }, [held]);

  // Thinking starts the drift; held or not, it settles on the loop.
  useEffect(() => {
    if (thinking) run();
  }, [thinking]);

  // The tag's side, sliding there; measured, so a tag to the left sits clear of the point.
  const [tagWidth, setTagWidth] = useState(TAG_WIDTH_GUESS);
  const widthTold = useEffectEvent((width: number) => {
    setTagWidth(width);
    onTagWidth?.(width);
  });
  useLayoutEffect(() => {
    const element = tag.current;
    if (element === null) return;
    widthTold(element.offsetWidth);
    const observer = new ResizeObserver(() => widthTold(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sliding = useRef<Sprung<"x" | "y"> | null>(null);
  useLayoutEffect(() => {
    const offset = tagOffset(side, tagWidth);
    if (sliding.current === null) {
      sliding.current = sprung(offset, "slide", ({ x, y }) => {
        tagPlace.current?.style.setProperty("transform", `translate(${x}px, ${y}px)`);
      });
      sliding.current.jump(offset);
    } else sliding.current.to(offset);
  }, [side, tagWidth]);
  useEffect(() => () => sliding.current?.stop(), []);

  const open = tagged || held;
  return (
    <span
      ref={placed}
      aria-hidden
      className="fade-in pointer-events-none absolute inset-0 block"
      style={{
        zIndex: layer,
        opacity: held ? pointer.heldOpacity : 1,
        transition: `opacity var(--duration-state) ${eases.out}`,
      }}
    >
      <span
        ref={bloom}
        className="absolute -top-[5px] -left-[5px] size-2.5 rounded-pill opacity-0"
        style={{ background: ink }}
      />
      <span
        ref={ring}
        className="absolute -top-3 -left-3 size-6 rounded-pill border-2 opacity-0"
        style={{ borderColor: ink }}
      />
      {/* The arrow turns and presses on its tip, at the box's corner: the tip stays on the point. */}
      <span ref={leaning} className="absolute top-0 left-0 block origin-top-left">
        <span ref={pressing} className="block origin-top-left">
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
      </span>
      <span ref={tagPlace} className="absolute top-0 left-0 block">
        <span
          ref={tag}
          className="flex items-center gap-1 rounded-pill ps-0.5 pe-2 text-2xs font-semibold whitespace-nowrap"
          style={{
            height: pointer.tagHeight,
            background: pointer.light,
            color: pointer.ink,
            border: `${pointer.tagEdge}px solid ${ink}`,
            boxShadow: pointer.tagShadow,
            transformOrigin: `${side.x > 0 ? "left" : "right"} ${side.y > 0 ? "top" : "bottom"}`,
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
            still={still}
          />
          {bot.profile.name}
        </span>
      </span>
    </span>
  );
}
