// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one frame loop of the page. Everything that moves frame by frame moves
 * from here: every avatar, and whatever travels on a spring it can be
 * interrupted on (`drive`, which `lib/sprung.ts` builds on). It runs only while
 * something moves, steps each avatar that is on screen, and draws the rest
 * still:
 *
 * - an avatar scrolled out of view (IntersectionObserver) is not stepped;
 * - an avatar at list size, under 44 px, steps every other frame, unless
 *   something of it travels (`everyFrame`);
 * - at most `MAX_MOVING` avatars move at once, the largest first; the others
 *   hold their still form until one stops, and draw it again when their state
 *   changes;
 * - under reduced motion nothing moves, and every avatar shows its still form.
 *
 * Each frame first reads what it must of the layout, then writes, so drawing
 * never forces a layout. What it reads are the avatars' boxes, only while a
 * pointer that moved lately may be near one, and only after the page scrolled
 * or something travelled, or `RECTS_KEPT` ms after it last read them: the
 * pointer moving does not move an avatar, so it is no reason to read again.
 * The pointer reaches an avatar only from close by (`pointerNear`): past that
 * the avatar is not told of it.
 */
import { pointerNear, type AvatarNear } from "@j3-bots/client-runtime/presentation";

/** One avatar as the loop drives it. */
export interface Animated {
  /** In px. */
  readonly size: number;
  /** Whether it may move at all: false for a still, stalled or sleeping avatar. */
  readonly moving: () => boolean;
  /** Its box on the page, for an eye that follows the pointer; null when it does not. */
  readonly measure: (() => DOMRect) | null;
  /** Steps it `dt` seconds and draws it; `near` is the pointer, when it is close by. */
  readonly step: (dt: number, near: AvatarNear | null) => void;
  /** Draws its still form. */
  readonly still: () => void;
  /**
   * Whether it steps on every frame whatever its size: something of it
   * travels, as a little one on its way out of its bot, which half the frames
   * would draw in jumps.
   */
  readonly everyFrame?: () => boolean;
}

/** An avatar on the loop, as its owner drives it. */
export interface Running {
  /**
   * Its state changed. If the loop steps it, it eases into the new state; if
   * the loop holds it, off screen or over the cap, it draws its new still
   * form on the next frame.
   */
  readonly restate: () => void;
  /** Takes it off the loop. */
  readonly stop: () => void;
}

/** The most avatars that move at once. */
const MAX_MOVING = 24;
/** Under this size, in px, an avatar steps at half rate. */
const LIST_SIZE = 44;
/**
 * How long after the pointer last moved an avatar near it keeps looking at
 * it, in ms: a pointer left lying beside a bot stops being interesting.
 */
const POINTER_HOLD = 3500;
/**
 * How long the avatars' boxes are trusted while nothing says they moved, in
 * ms: a layout that changed with no scroll and nothing travelling, as a pane
 * opening, is caught up with this soon.
 */
const RECTS_KEPT = 500;
/** The longest a frame counts for, in seconds: a tab that slept does not fast-forward. */
const LONGEST_FRAME = 0.1;

interface Entry {
  readonly avatar: Animated;
  visible: boolean;
  /** Time it has not been stepped for, carried into its next step. */
  owed: number;
  /** Whether the loop last drew it moving; when that changes, it draws its still form once. */
  drawnMoving: boolean;
  /** Its state changed since it was last drawn: until it is stepped, its still form is out of date. */
  restated: boolean;
  rect: DOMRect | null;
  readonly order: number;
}

const entries = new Set<Entry>();
/** The entries whose element the observer watches, by that element. */
const observed = new Map<Element, Entry>();
/** What else the loop steps: each returns whether it still moves. */
const drivers = new Set<(dt: number) => boolean>();
let frame = 0;
let raf = 0;
let last = 0;
let order = 0;
let rectsStale = true;
let rectsAt = 0;
let listening = false;
const pointer = { x: 0, y: 0, at: Number.NEGATIVE_INFINITY };

const reducedQuery =
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia("(prefers-reduced-motion: reduce)");

/** Whether the platform asks for reduced motion now. */
export const reducedMotion = () => reducedQuery?.matches ?? false;

const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (seen) => {
          for (const { target, isIntersecting } of seen) {
            const entry = observed.get(target);
            if (entry === undefined) continue;
            entry.visible = isIntersecting;
            if (!isIntersecting) settle(entry);
          }
          wake();
        },
        { rootMargin: "80px" },
      );

/** Draws `entry` still once, when it was last drawn moving or its state changed since. */
function settle(entry: Entry) {
  if (!entry.drawnMoving && !entry.restated) return;
  entry.drawnMoving = false;
  entry.restated = false;
  entry.avatar.still();
}

const onPointer = (event: PointerEvent) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.at = performance.now();
};
/** The pointer is gone: a finger lifted, or the mouse left the window, which is leaving for nothing. */
const onPointerGone = (event: PointerEvent) => {
  const left = event.type === "pointerout" ? event.relatedTarget === null : true;
  if (left && (event.type === "pointerout" || event.pointerType !== "mouse")) {
    pointer.at = Number.NEGATIVE_INFINITY;
  }
};
const onScroll = () => {
  rectsStale = true;
};

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("pointerup", onPointerGone, { passive: true });
  window.addEventListener("pointercancel", onPointerGone, { passive: true });
  window.addEventListener("pointerout", onPointerGone, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onScroll, { passive: true });
  reducedQuery?.addEventListener("change", onReducedChange);
}

function unlisten() {
  if (!listening || entries.size > 0 || drivers.size > 0) return;
  listening = false;
  window.removeEventListener("pointermove", onPointer);
  window.removeEventListener("pointerdown", onPointer);
  window.removeEventListener("pointerup", onPointerGone);
  window.removeEventListener("pointercancel", onPointerGone);
  window.removeEventListener("pointerout", onPointerGone);
  window.removeEventListener("scroll", onScroll, { capture: true });
  window.removeEventListener("resize", onScroll);
  reducedQuery?.removeEventListener("change", onReducedChange);
}

/** Starts the loop when something can move. */
function wake() {
  if (raf !== 0 || (entries.size === 0 && drivers.size === 0) || reducedMotion()) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

function loop(now: number) {
  raf = 0;
  if (reducedMotion()) return;
  const dt = Math.min(LONGEST_FRAME, Math.max(0, (now - last) / 1000));
  last = now;
  frame++;

  // Which avatars move this frame: visible, allowed to, the largest first, up to the cap.
  const candidates = [...entries].filter((e) => e.visible && e.avatar.moving());
  candidates.sort((a, b) => b.avatar.size - a.avatar.size || a.order - b.order);
  const moving = new Set(candidates.slice(0, MAX_MOVING));
  for (const entry of entries) if (!moving.has(entry)) settle(entry);

  // Reads first: the boxes of the avatars, when a pointer that moved lately may be near one.
  const following = now - pointer.at < POINTER_HOLD;
  if (following && (rectsStale || now - rectsAt > RECTS_KEPT)) {
    for (const entry of moving) entry.rect = entry.avatar.measure?.() ?? null;
    rectsStale = false;
    rectsAt = now;
  }

  // Then writes: what travels on its springs, then the avatars.
  let driving = false;
  for (const step of drivers) {
    if (step(dt)) driving = true;
    else drivers.delete(step);
  }
  // What travelled may have carried an avatar with it.
  if (driving) rectsStale = true;

  for (const entry of moving) {
    const half =
      entry.avatar.size < LIST_SIZE &&
      (frame + entry.order) % 2 === 1 &&
      entry.avatar.everyFrame?.() !== true;
    if (half) {
      entry.owed += dt;
      continue;
    }
    const rect = entry.rect;
    const near =
      following && rect !== null
        ? pointerNear(
            pointer.x - (rect.left + rect.width / 2),
            pointer.y - (rect.top + rect.height / 2),
            rect.width,
          )
        : null;
    entry.avatar.step(dt + entry.owed, near);
    entry.owed = 0;
    entry.drawnMoving = true;
    entry.restated = false;
  }
  if (moving.size > 0 || drivers.size > 0) raf = requestAnimationFrame(loop);
  else unlisten();
}

function onReducedChange() {
  if (reducedMotion()) {
    cancelAnimationFrame(raf);
    raf = 0;
    for (const entry of entries) settle(entry);
    // Whatever was travelling takes its place at once: a step of any length ends at rest.
    for (const step of drivers) step(Number.POSITIVE_INFINITY);
    drivers.clear();
  } else wake();
}

/**
 * Adds `avatar` to the loop, drawn still until the loop first steps it. When
 * `element` is given, the loop watches it and steps the avatar only while it
 * is in view.
 */
export function animate(avatar: Animated, element?: Element): Running {
  listen();
  const watched = element !== undefined && observer !== null ? element : null;
  const entry: Entry = {
    avatar,
    visible: watched === null,
    owed: 0,
    drawnMoving: false,
    restated: false,
    rect: null,
    order: order++,
  };
  entries.add(entry);
  if (watched !== null) {
    observed.set(watched, entry);
    observer?.observe(watched);
  }
  avatar.still();
  rectsStale = true;
  wake();
  return {
    restate: () => {
      if (!entries.has(entry)) return;
      entry.restated = true;
      wake();
    },
    stop: () => {
      if (watched !== null) {
        observer?.unobserve(watched);
        observed.delete(watched);
      }
      entries.delete(entry);
      if (entries.size > 0 || drivers.size > 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
      unlisten();
    },
  };
}

/**
 * Steps `step` on every frame, with the seconds since the last one, until it
 * returns false: it is at rest. Under reduced motion it is stepped once, with
 * no end of time, so it lands where it was going. Returns what takes it off
 * the loop.
 */
export function drive(step: (dt: number) => boolean): () => void {
  if (reducedMotion()) {
    step(Number.POSITIVE_INFINITY);
    return () => {};
  }
  listen();
  drivers.add(step);
  wake();
  return () => {
    drivers.delete(step);
    if (entries.size === 0 && drivers.size === 0) unlisten();
  };
}

/** Tells the loop an avatar was poked: it may have started moving. */
export const nudge = wake;
