// SPDX-License-Identifier: AGPL-3.0-or-later
import { EffortLevel } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ServerProviderModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { effortOptions, effortsOf, sameOptions } from "./Effort.ts";

const model = (optionDescriptors: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownSync(ServerProviderModel)({
    slug: "some-model",
    name: "Some Model",
    isCustom: false,
    capabilities: { optionDescriptors },
  });

// As Claude Code's catalog reports a model (`claudeReportedModels`, at `bc0f04d`).
const claudeModel = model([
  {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "default", label: "Default", isDefault: true },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ],
  },
  { id: "ultracode", label: "Ultracode", type: "boolean" },
]);

// As Codex reports one (`mapCodexModelCapabilities`, at `bc0f04d`).
const codexModel = model([
  {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "xhigh", label: "Extra High" },
    ],
    currentValue: "medium",
  },
  {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [{ id: "default", label: "Standard", isDefault: true }],
  },
]);

const level = EffortLevel.make;

describe("effortsOf", () => {
  it("offers Claude Code's levels, without its choice of none", () => {
    assert.deepStrictEqual(
      effortsOf(claudeModel).map((choice) => choice.id),
      ["low", "high", "max"],
    );
  });

  it("offers Codex's levels, and not its other selects", () => {
    assert.deepStrictEqual(effortsOf(codexModel), [
      { id: level("low"), name: "Low" },
      { id: level("medium"), name: "Medium" },
      { id: level("xhigh"), name: "Extra High" },
    ]);
  });

  it("offers the select an ACP agent marks as its reasoning", () => {
    const agent = model([
      {
        id: "thought_level",
        label: "Thinking",
        type: "select",
        role: "reasoning",
        options: [
          { id: "quick", label: "Quick" },
          { id: "deep", label: "Deep" },
        ],
      },
    ]);
    assert.deepStrictEqual(
      effortsOf(agent).map((choice) => choice.id),
      ["quick", "deep"],
    );
  });

  it("offers nothing for a model without a reasoning control", () => {
    assert.deepStrictEqual(effortsOf(model([])), []);
  });
});

describe("effortOptions", () => {
  it("asks for a level under the model's own control", () => {
    assert.deepStrictEqual(effortOptions(claudeModel, level("max")), [
      { id: "effort", value: "max" },
    ]);
    assert.deepStrictEqual(effortOptions(codexModel, level("xhigh")), [
      { id: "reasoningEffort", value: "xhigh" },
    ]);
  });

  it("asks for nothing for the default, a level the model lacks, or a model not reported", () => {
    assert.strictEqual(effortOptions(codexModel, null), undefined);
    assert.strictEqual(effortOptions(codexModel, level("max")), undefined);
    assert.strictEqual(effortOptions(undefined, level("high")), undefined);
  });
});

describe("sameOptions", () => {
  it("reads no options and an empty list alike, and a changed level as a change", () => {
    assert.isTrue(sameOptions(undefined, []));
    assert.isFalse(sameOptions(undefined, [{ id: "effort", value: "low" }]));
    assert.isFalse(
      sameOptions([{ id: "effort", value: "low" }], [{ id: "effort", value: "high" }]),
    );
    assert.isTrue(sameOptions([{ id: "effort", value: "low" }], [{ id: "effort", value: "low" }]));
  });
});
