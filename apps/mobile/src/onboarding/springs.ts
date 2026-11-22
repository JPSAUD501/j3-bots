// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Spring, springs } from "@j3-bots/client-runtime/presentation";

/**
 * A spring as Reanimated takes it: the same frequency and damping ratio the
 * web draws, for a mass of 1, so both clients move alike.
 */
const springConfig = (spring: Spring) => {
  const angular = 2 * Math.PI * spring.frequency;
  return { mass: 1, stiffness: angular * angular, damping: 2 * spring.damping * angular };
};

export const pop = springConfig(springs.pop);
export const soft = springConfig(springs.soft);
export const slide = springConfig(springs.slide);
