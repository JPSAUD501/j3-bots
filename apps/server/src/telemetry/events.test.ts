// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  Conflict,
  type EngineStatus,
  type ProviderStatus,
  Invalid,
  ModelId,
  NotFound,
  ProviderId,
  SecretName,
  SecretRefused,
} from "@j3-bots/contracts";
import { modelOf, originOf, requestFailedOf } from "./events.ts";

const CLAUDE = ProviderId.make("claude");
const GATEWAY = ProviderId.make("gateway");

const provider = (
  id: ProviderId,
  harness: ProviderStatus["harness"],
  models: ProviderStatus["models"],
): ProviderStatus => ({
  id,
  name: id,
  harness,
  status: { _tag: "ready" },
  models,
  usage: [],
});

/** An engine that lists one Claude Code model of its own, one the operator added, and a provider of another harness. */
const status: EngineStatus = {
  state: { _tag: "ready" },
  pinnedVersion: "0.1.13",
  providers: [
    provider(CLAUDE, "claude-code", [
      { id: ModelId.make("claude-opus-5-5"), name: "Claude Opus 5.5" },
      { id: ModelId.make("my-team-finetune"), name: "Our finetune", custom: true },
    ]),
    provider(GATEWAY, "other", [{ id: ModelId.make("gateway-large"), name: "Gateway large" }]),
  ],
};

describe("the model an event names", () => {
  it("is the engine's catalog id for a model it lists of its own", () => {
    assert.strictEqual(
      modelOf(status, { providerId: CLAUDE, modelId: ModelId.make("claude-opus-5-5") }),
      "claude-opus-5-5",
    );
  });

  it("is custom for a model someone added, one the engine does not list, or another harness's", () => {
    const custom = (providerId: ProviderId, modelId: string) =>
      modelOf(status, { providerId, modelId: ModelId.make(modelId) });
    assert.strictEqual(custom(CLAUDE, "my-team-finetune"), "custom");
    assert.strictEqual(custom(CLAUDE, "claude-unlisted"), "custom");
    assert.strictEqual(custom(GATEWAY, "gateway-large"), "custom");
    assert.strictEqual(
      modelOf(null, { providerId: CLAUDE, modelId: ModelId.make("claude-opus-5-5") }),
      "custom",
    );
  });
});

describe("where a turn came from", () => {
  it("is its first wake's place, and a routine's event trigger is an event", () => {
    assert.strictEqual(
      originOf([
        { kind: "user", trigger: null },
        { kind: "room", trigger: null },
      ]),
      "conversation",
    );
    assert.strictEqual(originOf([{ kind: "routine", trigger: "event" }]), "event");
    assert.strictEqual(originOf([{ kind: "routine", trigger: "schedule" }]), "routine");
    assert.strictEqual(originOf([{ kind: "bot", trigger: null }]), "teammate");
    assert.strictEqual(originOf([]), "other");
  });
});

describe("a failed request", () => {
  it("is told by its tag and code, never its text or the secret it names", () => {
    assert.deepStrictEqual(requestFailedOf(new NotFound({ resource: "bot" })).properties, {
      error: "NotFound",
      code: "bot",
    });
    assert.deepStrictEqual(
      requestFailedOf(new Conflict({ reason: "engine-unavailable" })).properties,
      { error: "Conflict", code: "engine-unavailable" },
    );
    assert.deepStrictEqual(requestFailedOf(new Invalid({ reason: "quotes" })).properties, {
      error: "Invalid",
      code: "quotes",
    });
    assert.deepStrictEqual(
      requestFailedOf(
        new SecretRefused({ secret: SecretName.make("bank-password"), problem: "not-shared" }),
      ).properties,
      { error: "SecretRefused", code: "not-shared" },
    );
    assert.deepStrictEqual(requestFailedOf(new Error("disk full at /home/someone")).properties, {
      error: "other",
      code: null,
    });
  });
});
