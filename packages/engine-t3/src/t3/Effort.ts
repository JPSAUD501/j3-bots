// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EffortChoice, EffortLevel, MAX_LABEL_LENGTH } from "@j3-bots/contracts";
import type {
  ProviderOptionSelection,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The ids the engine gives a model's reasoning control: Claude Code's
 * `effort` and Codex's `reasoningEffort` (**Read** at `bc0f04d`,
 * `ClaudeModelCatalog.ts` `claudeReportedModels`, `CodexProvider.ts`
 * `mapCodexModelCapabilities`).
 */
const REASONING_CONTROLS: ReadonlySet<string> = new Set(["effort", "reasoningEffort"]);

/**
 * Claude Code's choice that sends no effort, so that Claude Code picks its
 * own: not a level (**Read** at `bc0f04d`, `claudeReportedModels`).
 */
const HARNESS_DEFAULT = "default";

/**
 * The model's reasoning control, as the engine reports it: one of
 * `REASONING_CONTROLS`, or the select an ACP agent marks as its reasoning
 * (`role: "reasoning"`, **Read** at `bc0f04d`, `model.ts`).
 */
const reasoningControl = (model: ServerProviderModel): SelectProviderOptionDescriptor | undefined =>
  model.capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || REASONING_CONTROLS.has(descriptor.id)),
  );

const decodeLevel = Schema.decodeUnknownOption(EffortLevel);

/**
 * The levels of effort the model takes, in the engine's order, which is
 * lowest first for Claude Code (**Read** at `bc0f04d`, `CLAUDE_EFFORT_LEVELS`)
 * and Codex's own order for Codex (**Assumed** lowest first). The harness's
 * default is not a level: choosing none is. A level whose id J3 Bots cannot
 * hold is left out.
 */
export const effortsOf = (model: ServerProviderModel): ReadonlyArray<EffortChoice> =>
  (reasoningControl(model)?.options ?? []).flatMap((option) =>
    option.id === HARNESS_DEFAULT
      ? []
      : Option.match(decodeLevel(option.id), {
          onNone: () => [],
          onSome: (id) => [{ id, name: option.label.slice(0, MAX_LABEL_LENGTH) }],
        }),
  );

/**
 * How the engine reports a model's fast mode (**Read** at `bc0f04d`): Claude
 * Code's as a `fastMode` switch (`claudeModelOptions.ts`
 * `compileClaudeModelSelection`, the Opus profiles of `model-manifest.json`),
 * Codex's as a `serviceTier` select whose `fast` choice it sends as its fast
 * tier (`CodexProvider.ts`, `codexModelOptions.ts`). Codex's other tiers, as
 * `ultrafast`, are not offered: J3 Bots offers Standard and Fast only.
 */
const FAST_MODE = "fastMode";
const SERVICE_TIER = "serviceTier";
const FAST_TIER = "fast";

/** The option that asks the model for its fast mode, when the engine reports one. */
const fastOption = (model: ServerProviderModel): ProviderOptionSelection | undefined => {
  for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
    if (descriptor.type === "boolean" && descriptor.id === FAST_MODE) {
      return { id: FAST_MODE, value: true };
    }
    if (
      descriptor.type === "select" &&
      descriptor.id === SERVICE_TIER &&
      descriptor.options.some((choice) => choice.id === FAST_TIER)
    ) {
      return { id: SERVICE_TIER, value: FAST_TIER };
    }
  }
  return undefined;
};

/** Whether the engine reports a fast mode for the model. */
export const hasFastMode = (model: ServerProviderModel): boolean => fastOption(model) !== undefined;

/**
 * The options of a model selection that ask `model` for `effort` and, with
 * `fast`, its fast mode: none for the harness's default, and none for a level
 * or a fast mode the engine does not report for the model now, nor for a
 * model it does not report, which then runs at the default. The engine would
 * send Codex a level the model lacks as it is, and Codex would fail the turn
 * (**Read** at `bc0f04d`, `CodexAdapterV2.ts` `startTurn`). Undefined when
 * none is asked.
 */
export const modelOptions = (
  model: ServerProviderModel | undefined,
  effort: EffortLevel | null,
  fast: boolean,
): ReadonlyArray<ProviderOptionSelection> | undefined => {
  if (model === undefined) return undefined;
  const control = reasoningControl(model);
  const speed = fast ? fastOption(model) : undefined;
  const options: ReadonlyArray<ProviderOptionSelection> = [
    ...(effort !== null &&
    control !== undefined &&
    control.options.some((option) => option.id === effort)
      ? [{ id: control.id, value: effort }]
      : []),
    ...(speed === undefined ? [] : [speed]),
  ];
  return options.length === 0 ? undefined : options;
};

/** Whether the engine reports, for `model`, each level and fast mode that `options` ask for. */
const offersOptions = (
  model: ServerProviderModel,
  options: ReadonlyArray<ProviderOptionSelection>,
): boolean => {
  const control = reasoningControl(model);
  const speed = fastOption(model);
  return options.every((option) =>
    option.id === FAST_MODE || option.id === SERVICE_TIER
      ? speed !== undefined && speed.id === option.id && speed.value === option.value
      : control !== undefined &&
        option.id === control.id &&
        control.options.some((choice) => choice.id === option.value),
  );
};

/**
 * The options a thread's selection takes before a turn, when they change:
 * none, when the engine no longer reports a level or the fast mode the thread
 * asks for for its model, and the options dropped so, `dropped`, once the
 * engine reports them again. `undefined` keeps the selection as it is.
 */
export const levelBeforeTurn = (
  model: ServerProviderModel,
  asked: ReadonlyArray<ProviderOptionSelection>,
  dropped: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined => {
  if (asked.length > 0) return offersOptions(model, asked) ? undefined : [];
  return dropped !== undefined && offersOptions(model, dropped) ? dropped : undefined;
};

/** Whether two selections' options ask the same, none and an empty list alike. */
export const sameOptions = (
  a: ReadonlyArray<ProviderOptionSelection> | undefined,
  b: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((option) => right.find((other) => other.id === option.id)?.value === option.value)
  );
};
