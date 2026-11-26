// SPDX-License-Identifier: AGPL-3.0-or-later
import { AvatarChoice, type EngineStatus, type Language } from "@j3-bots/contracts";
import { avatarCast } from "@j3-bots/design-tokens";
import * as Schema from "effect/Schema";
import { providerGate } from "./engine.ts";

/**
 * The first run, one thing per screen, from the welcome to the first bot's
 * arrival; its conversation opens after it.
 * - `welcome`, `work` and `mind`: what J3 Bots is, before anything is asked: a
 *   small team of bots of the operator's own, what they do day to day, and
 *   what they think with, which is what J3 Bots installs;
 * - `name` and `look`: the first bot, each with a default, so Continue always works;
 * - `connect`: only while no provider can run the bot. It never holds the bot
 *   back: the bot is created anyway, and says hello once a provider can run it;
 * - `arrival`: the bot is being created, and then it is here.
 */
const onboardingSteps = ["welcome", "work", "mind", "name", "look", "connect", "arrival"] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];

/** Which of the steps that come only when needed the first run shows. */
export interface OnboardingFlow {
  readonly connect: boolean;
}

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

const order = (flow: OnboardingFlow): ReadonlyArray<OnboardingStep> =>
  onboardingSteps.filter((step) => step !== "connect" || flow.connect);

/** The step after `at`; null after the arrival, when the conversation opens. */
export const nextStep = (at: OnboardingStep, flow: OnboardingFlow): OnboardingStep | null => {
  const steps = order(flow);
  return steps[steps.indexOf(at) + 1] ?? null;
};

/** The step Back returns to; null where there is none: the welcome, and the arrival, which is under way. */
export const previousStep = (at: OnboardingStep, flow: OnboardingFlow): OnboardingStep | null => {
  if (at === "arrival") return null;
  const steps = order(flow);
  return steps[steps.indexOf(at) - 1] ?? null;
};

/**
 * Whether `step` is one of the story's: it tells and asks nothing, with the
 * whole cast on the stage. The steps after it are about the one bot being made.
 */
export const tellsStory = (step: OnboardingStep): boolean =>
  step === "welcome" || step === "work" || step === "mind";

/** Every step before the arrival is a dot in the progress: where `at` is among them, and how many. */
export const stepProgress = (
  at: OnboardingStep,
  flow: OnboardingFlow,
): { readonly index: number; readonly count: number } | null => {
  const steps: ReadonlyArray<OnboardingStep> = order(flow).filter((step) => step !== "arrival");
  const index = steps.indexOf(at);
  return index === -1 ? null : { index, count: steps.length };
};

/** One of the bots on the first run's stage. */
export interface StageActor {
  readonly look: AvatarChoice;
  /** In px. */
  readonly size: number;
  /** Where it stands across the stage, in % of its width. */
  readonly x: number;
  /** How far upstage it stands: each step back is a little higher and a little dimmer. */
  readonly depth: 0 | 1 | 2;
}

/** The cast's look at `index`: the first is the one the first bot starts with. */
const castLook = (index: number): AvatarChoice =>
  avatarCast[index % avatarCast.length] ?? avatarCast[0];

/**
 * The cast: the lead, which becomes the bot being made, at the front in the
 * middle, and four more around and behind it, in the order they come in.
 */
export const stageCast: readonly [StageActor, ...ReadonlyArray<StageActor>] = [
  { look: castLook(0), size: 96, x: 50, depth: 0 },
  { look: castLook(3), size: 60, x: 16, depth: 1 },
  { look: castLook(1), size: 64, x: 84, depth: 1 },
  { look: castLook(2), size: 50, x: 31, depth: 2 },
  { look: castLook(5), size: 46, x: 70, depth: 2 },
];

/** The cast from one side of the stage to the other, as places in `stageCast`. */
export const acrossStage: ReadonlyArray<number> = [...stageCast.keys()].sort(
  (a, b) => (stageCast[a]?.x ?? 0) - (stageCast[b]?.x ?? 0),
);

/**
 * What the bots do for the operator day to day, one example each, in the
 * order the `work` step's light visits them: one bot across the stage for each,
 * and the whole cast for the last.
 */
export const workExamples = [
  "files",
  "research",
  "writing",
  "routines",
  "watch",
  "together",
] as const;
export type WorkExample = (typeof workExamples)[number];

/** Who has the light for an example: a place in `stageCast`, or everyone. */
export type Featured = number | "all";

/**
 * The `work` step's turn `turn`, counted from 0 as the step shows and going
 * round: the example it is about, and who has the light for it.
 */
export const workTurn = (
  turn: number,
): { readonly example: WorkExample; readonly featured: Featured } => {
  const at = Math.abs(Math.trunc(turn)) % workExamples.length;
  return { example: workExamples[at] ?? workExamples[0], featured: acrossStage[at] ?? "all" };
};

/**
 * How the stage is set for a step: every surface draws the first run as one
 * stage, the bots standing on it in their lights, and changes the set, never
 * the stage, from step to step.
 */
export interface StageScene {
  /**
   * Where the camera is: `wide` on the whole cast, `close` on the bot being
   * made, `finale` pulled back a little past wide as the bot arrives.
   */
  readonly camera: "wide" | "close" | "finale";
  /**
   * The cast's lights:
   * - `lit`: each bot in its own;
   * - `turns`: one bot at a time has the light, the others stand in what
   *   spills from it (`workTurn` says whose turn it is);
   * - `thinking`: every bot thinks, under the one light the whole cast
   *   shares, wide and cool, in place of its own;
   * - `dim`: only the bot being made is lit, the others stand back in the
   *   dark, watching.
   */
  readonly cast: "lit" | "turns" | "thinking" | "dim";
  /** The lead's light: `tight` while the operator fills in a form, so the form has the eye. */
  readonly spot: "open" | "tight";
  /** Whether the bot being made wears its name. */
  readonly named: boolean;
}

/** The set for `step`; `created` once the bot exists, which turns the arrival into the finale. */
export const stageScene = (step: OnboardingStep, created: boolean): StageScene => {
  switch (step) {
    case "welcome":
      return { camera: "wide", cast: "lit", spot: "open", named: false };
    case "work":
      return { camera: "wide", cast: "turns", spot: "open", named: false };
    case "mind":
      return { camera: "wide", cast: "thinking", spot: "open", named: false };
    case "name":
    case "look":
      return { camera: "close", cast: "dim", spot: "open", named: true };
    case "connect":
      return { camera: "close", cast: "dim", spot: "tight", named: true };
    case "arrival":
      return created
        ? { camera: "finale", cast: "lit", spot: "open", named: false }
        : { camera: "close", cast: "dim", spot: "tight", named: false };
  }
};

/**
 * How a bot on the stage is lit in a scene:
 * - `key`: in its own light, at full strength;
 * - `fill`: in its own light, softer, as the cast around the lead;
 * - `spill`: in no light of its own, only what spills from another's;
 * - `shared`: under the one light the whole cast shares.
 */
export type StageLight = "key" | "fill" | "spill" | "shared";

/**
 * The light on the bot at `place` in `stageCast`, in `scene`; `featured` is
 * who has the light while the cast takes turns.
 */
export const stageLight = (scene: StageScene, place: number, featured: Featured): StageLight => {
  const lead = place === 0;
  switch (scene.cast) {
    case "lit":
      return lead ? "key" : "fill";
    case "turns":
      return featured === "all" || featured === place ? "key" : "spill";
    case "thinking":
      return "shared";
    case "dim":
      return lead ? "key" : "spill";
  }
};

/**
 * What a first run left off at, kept by the device so that leaving it, a
 * closed tab or an app put away, does not start it over: the step, the name
 * typed if any, and the look picked.
 */
export const FirstRunProgress = Schema.Struct({
  step: Schema.Literals(onboardingSteps),
  name: Schema.NullOr(Schema.String),
  look: AvatarChoice,
});
export type FirstRunProgress = typeof FirstRunProgress.Type;

/**
 * The step a first run left at `step` starts again from. A step the flow no
 * longer has, as a connect step once a provider connected, and the arrival,
 * which only a bot being created shows, go back to the look, the last step
 * every flow has before them.
 */
export const resumedStep = (step: OnboardingStep, flow: OnboardingFlow): OnboardingStep =>
  step !== "arrival" && order(flow).includes(step) ? step : "look";

/**
 * What the server is getting ready before a bot can run on it: the engine it
 * downloads on its first start, and its own copies of the harnesses.
 * - `preparing`: something is on its way. `fraction` is how far, from 0 to 1,
 *   across what is being downloaded now; null while a size is not known, or
 *   the server has not said anything yet;
 * - `ready`: the engine runs and nothing it could install is missing;
 * - `idle`: neither can be said: the server has not reported, its engine is
 *   not running for a reason that does not pass by itself, or a harness is
 *   missing with no install under way, which the connect step says.
 */
export type Preparation =
  | { readonly _tag: "idle" }
  | { readonly _tag: "preparing"; readonly fraction: number | null }
  | { readonly _tag: "ready" };

const downloaded = (received: number, total: number | null): number | null =>
  total === null || total === 0 ? null : Math.min(1, received / total);

/**
 * What the server is getting ready now (`Preparation`), from the status the
 * clients already read. `starting` is what only the device knows: that its
 * server is starting and has not answered yet, as on the computer that runs it.
 */
export const preparation = (engine: EngineStatus | null, starting: boolean): Preparation => {
  if (engine === null) return starting ? { _tag: "preparing", fraction: null } : { _tag: "idle" };
  if (engine.state._tag === "starting") {
    const { install } = engine.state;
    return {
      _tag: "preparing",
      fraction:
        install === undefined ? null : downloaded(install.receivedBytes, install.totalBytes),
    };
  }
  if (engine.state._tag !== "ready") return { _tag: "idle" };
  // A copy that waits for the bots to finish is an update, which nothing waits for.
  const parts = engine.providers.flatMap(({ copy }): ReadonlyArray<number | null> => {
    const task = copy?.task ?? null;
    if (task === null || task._tag === "waiting") return [];
    return [task._tag === "verifying" ? 1 : downloaded(task.receivedBytes, task.totalBytes)];
  });
  if (parts.length === 0) {
    const missing = engine.providers.some(
      ({ copy }) => copy !== undefined && copy.source === "none" && copy.installable,
    );
    return { _tag: missing ? "idle" : "ready" };
  }
  let sum = 0;
  for (const part of parts) {
    if (part === null) return { _tag: "preparing", fraction: null };
    sum += part;
  }
  return { _tag: "preparing", fraction: sum / parts.length };
};

/**
 * The share a preparation under way shows, from 0 to 0.99: never the whole,
 * which would say it is done while it is not. Null where there is none to show.
 */
export const preparedShare = (now: Preparation): number | null =>
  now._tag !== "preparing" || now.fraction === null
    ? null
    : Math.min(0.99, Math.max(0, Math.floor(now.fraction * 100) / 100));

/** Where the install guide says how to sign a harness in with its own account (`provider login`). */
export const providerLoginGuide =
  "https://github.com/JPSAUD501/j3-bots/blob/main/docs/operations/install.md#connect-the-providers";

/**
 * First names a person on a team would have, common where each language is
 * spoken, short, and each with its own first letter: one is the first bot's
 * default, in the operator's language.
 */
const firstNames: { readonly [L in Language]: readonly [string, ...Array<string>] } = {
  en: ["Maya", "Leo", "Nora", "Sam", "Ellie", "Owen", "Ruby", "Jack"],
  "pt-BR": ["Bia", "Davi", "Lara", "Caio", "Júlia", "Malu", "Rafa", "Tiago"],
};

/** The first bot's default name in `language`, chosen by `seed`, any whole number: a random one gives a random name. */
export const defaultBotName = (language: Language, seed: number): string => {
  const names = firstNames[language];
  return names[Math.abs(Math.trunc(seed)) % names.length] ?? names[0];
};
