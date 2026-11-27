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
 * The options of a model selection that ask `model` for `effort`: none for the
 * harness's default, and none for a level the engine does not report for the
 * model now, nor for a model it does not report, which then runs at the
 * default. The engine would send Codex a level the model lacks as it is, and
 * Codex would fail the turn (**Read** at `bc0f04d`, `CodexAdapterV2.ts`
 * `startTurn`).
 */
export const effortOptions = (
  model: ServerProviderModel | undefined,
  effort: EffortLevel | null,
): ReadonlyArray<ProviderOptionSelection> | undefined => {
  if (effort === null || model === undefined) return undefined;
  const control = reasoningControl(model);
  return control !== undefined && control.options.some((option) => option.id === effort)
    ? [{ id: control.id, value: effort }]
    : undefined;
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
