// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarChoice, EngineStatus } from "@j3-bots/contracts";
import { providerGate } from "./engine.ts";

/**
 * The first run, one thing per screen, from the welcome to the first bot's
 * arrival; its conversation opens after it.
 * - `welcome`: what bots are;
 * - `name` and `look`: the first bot, each with a default, so Continue always works;
 * - `connect`: only while no provider can run the bot. It never holds the bot
 *   back: the bot is created anyway, and says hello once a provider can run it;
 * - `arrival`: the bot is being created, and then it is here.
 */
export type OnboardingStep = "welcome" | "name" | "look" | "connect" | "arrival";

/**
 * Whether the first run shows `connect`: while no provider can run a bot, or
 * the engine is not running, and, once it was `shown`, until the first run
 * ends. So a provider that connects while the operator reads the step, or
 * after they go Back from it, does not take it out of the flow: the progress
 * keeps its dots, and the look's button stays Continue.
 */
export const showsConnect = (engine: EngineStatus | null, shown: boolean): boolean =>
  shown ||
  engine === null ||
  engine.state._tag !== "ready" ||
  providerGate(engine)._tag !== "ready";

const order = (connect: boolean): ReadonlyArray<OnboardingStep> =>
  connect
    ? ["welcome", "name", "look", "connect", "arrival"]
    : ["welcome", "name", "look", "arrival"];

/** The step after `at`; null after the arrival, when the conversation opens. */
export const nextStep = (at: OnboardingStep, connect: boolean): OnboardingStep | null => {
  const steps = order(connect);
  return steps[steps.indexOf(at) + 1] ?? null;
};

/** The step Back returns to; null where there is none: the welcome, and the arrival, which is under way. */
export const previousStep = (at: OnboardingStep, connect: boolean): OnboardingStep | null => {
  if (at === "arrival") return null;
  const steps = order(connect);
  return steps[steps.indexOf(at) - 1] ?? null;
};

/** The steps that make the bot, each a dot in the progress: where `at` is among them, and how many. */
export const makingProgress = (
  at: OnboardingStep,
  connect: boolean,
): { readonly index: number; readonly count: number } | null => {
  const making: ReadonlyArray<OnboardingStep> = order(connect).filter(
    (step) => step !== "welcome" && step !== "arrival",
  );
  const index = making.indexOf(at);
  return index === -1 ? null : { index, count: making.length };
};

/** Where the install guide says how to sign a harness in with its own account (`provider login`). */
export const providerLoginGuide =
  "https://github.com/JPSAUD501/j3-bots/blob/main/docs/operations/install.md#connect-the-providers";

/** Short names that read well in English and Portuguese: one is the first bot's default. */
const firstNames = ["Nova", "Juno", "Milo", "Iris", "Otto", "Luma", "Pip", "Theo"] as const;

/** The first bot's default name, chosen by `seed`, any whole number: a random one gives a random name. */
export const defaultBotName = (seed: number): string =>
  firstNames[Math.abs(Math.trunc(seed)) % firstNames.length] ?? firstNames[0];

/**
 * Looks that suit a first bot, the first one its default: bright, and never
 * the red that reads as an error. Today's avatars; the avatar picker replaces
 * this list with its own defaults.
 */
export const firstLooks: readonly [AvatarChoice, ...AvatarChoice[]] = [
  { shape: "arch", color: "blue" },
  { shape: "clover", color: "green" },
  { shape: "burst", color: "orange" },
  { shape: "hexagon", color: "violet" },
  { shape: "leaf", color: "teal" },
  { shape: "circle", color: "pink" },
  { shape: "diamond", color: "indigo" },
  { shape: "square", color: "yellow" },
];
