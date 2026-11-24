// SPDX-License-Identifier: AGPL-3.0-or-later
import { springs } from "@j3-bots/design-tokens";
import { useSyncExternalStore } from "react";

const reducedQuery = "(prefers-reduced-motion: reduce)";

const subscribe = (change: () => void) => {
  const query = window.matchMedia(reducedQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether the system asks for reduced motion, following the setting as it changes. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(reducedQuery).matches,
    () => false,
  );

/**
 * A CSS `animation` that plays `keyframes` along one of the design tokens'
 * springs, by its `--ease-*` and `--duration-*` names. Reduced motion needs
 * nothing here: the page's reduced-motion rule ends every animation at once,
 * which leaves each element in its still form.
 */
export const springAnimation = (
  keyframes: string,
  spring: keyof typeof springs = "slide",
  delay = 0,
): string => `${keyframes} var(--duration-${spring}) var(--ease-${spring}) ${delay}ms both`;

/** Plays `keyframes` on `element` along a spring, on the compositor where they are transforms. */
export const playSpring = (
  element: Element,
  keyframes: ReadonlyArray<Keyframe>,
  spring: keyof typeof springs,
  fill: FillMode = "none",
): Animation =>
  element.animate([...keyframes], {
    duration: springs[spring].duration,
    easing: springs[spring].easing,
    fill,
  });

/** Where a box sits on the page and how wide it is: enough to move one onto another. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const centre = (box: DOMRectReadOnly): Box => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
  width: box.width,
});

/** The box `element` takes on the page, by its centre. */
export const boxOf = (element: Element): Box => centre(element.getBoundingClientRect());

/** The transform that puts `element`, as it is laid out, onto `box`. */
const onto = (element: Element, box: Box): string => {
  const here = boxOf(element);
  return `translate(${box.x - here.x}px, ${box.y - here.y}px) scale(${box.width / here.width})`;
};

/**
 * Carries `element` from `box` to where it is laid out, on `slide`: the same
 * thing seen moving from one place to another rather than drawn twice.
 */
export const carryFrom = (element: HTMLElement, box: Box): Animation =>
  playSpring(element, [{ transform: onto(element, box) }, { transform: "none" }], "slide");

/** Carries `element` from where it is laid out onto `box`, on `slide`, and holds it there. */
export const carryTo = (element: HTMLElement, box: Box): Animation =>
  playSpring(
    element,
    [{ transform: "none" }, { transform: onto(element, box) }],
    "slide",
    "forwards",
  );
