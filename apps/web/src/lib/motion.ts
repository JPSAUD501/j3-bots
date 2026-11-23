// SPDX-License-Identifier: AGPL-3.0-or-later

/** Whether the operator asked the system for less motion, as it stands now. */
export const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How a motion runs: a spring token, or a duration on an easing. */
interface Timing {
  readonly duration: number;
  readonly easing: string;
}

/**
 * Plays `keyframes` on `element` with `timing`'s easing and duration, from
 * the first keyframe to the element as it stands. Under reduced motion it
 * plays nothing: the element is already in its still form. Every motion in
 * a conversation goes through here.
 */
export function play(
  element: Element,
  keyframes: ReadonlyArray<Keyframe>,
  timing: Timing,
  options: { readonly delay?: number } = {},
): Animation | null {
  if (reducedMotion()) return null;
  return element.animate([...keyframes], {
    duration: timing.duration,
    easing: timing.easing,
    delay: options.delay ?? 0,
    fill: "backwards",
  });
}
