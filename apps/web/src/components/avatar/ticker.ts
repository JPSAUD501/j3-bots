// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one frame loop every avatar on the page shares. It runs only while some
 * avatar moves, steps each one that is on screen, and draws the rest still:
 *
 * - an avatar scrolled out of view (IntersectionObserver) is not stepped;
 * - an avatar at list size, under 44 px, steps every other frame;
 * - at most `MAX_MOVING` avatars move at once, the largest first; the others
 *   hold their still form until one stops;
 * - under reduced motion nothing moves, and every avatar shows its still form.
 *
 * Each frame first reads what it must of the layout (the boxes of avatars
 * whose eye follows the pointer, and only after the pointer moved or the page
 * scrolled), then writes, so drawing never forces a layout.
 */
import { gazeToward, type AvatarGaze } from "@j3-bots/client-runtime/presentation";

/** One avatar as the loop drives it. */
export interface Animated {
  /** In px. */
  readonly size: number;
  /** Whether it may move at all: false for a still or stalled avatar. */
  readonly moving: () => boolean;
  /** Whether its eye follows the pointer. */
  readonly tracks: boolean;
  readonly element: Element;
  /** Steps it `dt` seconds and draws it. */
  readonly step: (dt: number, gaze: AvatarGaze | null) => void;
  /** Draws its still form. */
  readonly still: () => void;
}

/** The most avatars that move at once. */
const MAX_MOVING = 24;
/** Under this size, in px, an avatar steps at half rate. */
const LIST_SIZE = 44;
/** How long after the pointer last moved the eyes keep following it, in ms. */
const POINTER_HOLD = 2400;

interface Entry {
  readonly avatar: Animated;
  visible: boolean;
  /** Time it has not been stepped for, carried into its next step. */
  owed: number;
  /** Whether the loop last drew it moving; when that changes, it draws its still form once. */
  drawnMoving: boolean;
  rect: DOMRect | null;
  readonly order: number;
}

const entries = new Map<Element, Entry>();
let frame = 0;
let raf = 0;
let last = 0;
let order = 0;
let rectsStale = true;
const pointer = { x: 0, y: 0, at: Number.NEGATIVE_INFINITY };

const reducedQuery =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer =
  typeof window === "undefined" ? null : window.matchMedia("(hover: hover) and (pointer: fine)");

/** Whether the platform asks for reduced motion now. */
export const reducedMotion = () => reducedQuery?.matches ?? false;

const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (seen) => {
          for (const { target, isIntersecting } of seen) {
            const entry = entries.get(target);
            if (entry === undefined) continue;
            entry.visible = isIntersecting;
            if (!isIntersecting) settle(entry);
          }
          wake();
        },
        { rootMargin: "80px" },
      );

/** Draws `entry` still once, when it was last drawn moving. */
function settle(entry: Entry) {
  if (!entry.drawnMoving) return;
  entry.drawnMoving = false;
  entry.avatar.still();
}

const onPointer = (event: PointerEvent) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.at = performance.now();
  rectsStale = true;
};
const onScroll = () => {
  rectsStale = true;
};

/** Starts the loop when something can move, and stops listening when nothing is left. */
function wake() {
  if (raf !== 0 || entries.size === 0 || reducedMotion()) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

function loop(now: number) {
  raf = 0;
  if (reducedMotion()) return;
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  frame++;

  // Which avatars move this frame: visible, allowed to, the largest first, up to the cap.
  const candidates = [...entries.values()].filter((e) => e.visible && e.avatar.moving());
  candidates.sort((a, b) => b.avatar.size - a.avatar.size || a.order - b.order);
  const moving = new Set(candidates.slice(0, MAX_MOVING));
  for (const entry of entries.values()) if (!moving.has(entry)) settle(entry);
  if (moving.size === 0) return;

  // Reads first: the boxes of avatars that follow a pointer that just moved.
  const following = finePointer?.matches === true && now - pointer.at < POINTER_HOLD;
  if (following && rectsStale) {
    for (const entry of moving) {
      if (entry.avatar.tracks) entry.rect = entry.avatar.element.getBoundingClientRect();
    }
    rectsStale = false;
  }

  // Then writes.
  for (const entry of moving) {
    const half = entry.avatar.size < LIST_SIZE && (frame + entry.order) % 2 === 1;
    if (half) {
      entry.owed += dt;
      continue;
    }
    const rect = entry.rect;
    const gaze =
      following && entry.avatar.tracks && rect !== null
        ? gazeToward(
            pointer.x - (rect.left + rect.width / 2),
            pointer.y - (rect.top + rect.height / 2),
          )
        : null;
    entry.avatar.step(dt + entry.owed, gaze);
    entry.owed = 0;
    entry.drawnMoving = true;
  }
  raf = requestAnimationFrame(loop);
}

function onReducedChange() {
  if (reducedMotion()) {
    cancelAnimationFrame(raf);
    raf = 0;
    for (const entry of entries.values()) settle(entry);
  } else wake();
}

/**
 * Adds `avatar` to the loop, drawn still until the loop first steps it.
 * Returns what takes it out again.
 */
export function animate(avatar: Animated): () => void {
  if (entries.size === 0) {
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onScroll, { passive: true });
    reducedQuery?.addEventListener("change", onReducedChange);
  }
  const entry: Entry = {
    avatar,
    visible: observer === null,
    owed: 0,
    drawnMoving: false,
    rect: null,
    order: order++,
  };
  entries.set(avatar.element, entry);
  observer?.observe(avatar.element);
  avatar.still();
  rectsStale = true;
  wake();
  return () => {
    observer?.unobserve(avatar.element);
    entries.delete(avatar.element);
    if (entries.size > 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", onScroll);
    reducedQuery?.removeEventListener("change", onReducedChange);
  };
}

/** Tells the loop an avatar may have started moving: its state changed, or it was poked. */
export const nudge = wake;
