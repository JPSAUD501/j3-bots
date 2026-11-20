// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Engine } from "../src/Engine.ts";
import { EngineRequest } from "../src/events.ts";
import { IdempotencyKey, type SessionId, type TurnId } from "../src/ids.ts";
import * as TestEngine from "../src/testing/TestEngine.ts";
import { type Act, Bench } from "./Bench.ts";
import { scenarios } from "./scenarios.ts";

// The conformance scenarios against the in-memory double. The same scenarios
// run against the real engine in `real.conformance.ts`.

const request = Schema.decodeUnknownSync(EngineRequest);

const REQUESTS = {
  approval: request({
    _tag: "approval",
    kind: "file-change",
    action: "Write notes.txt",
    detail: null,
    reason: null,
    exact: false,
    allowsSession: false,
  }),
  question: request({
    _tag: "question",
    questions: [
      {
        id: "colour",
        prompt: "Which colour?",
        options: [
          { id: "red", label: "Red", description: "Red", style: "default" },
          { id: "blue", label: "Blue", description: "Blue", style: "default" },
        ],
        acceptsText: false,
        multiple: false,
      },
    ],
  }),
  secret: request({
    _tag: "secret",
    label: "Scripted token",
    reason: "The conformance suite asks for a secret.",
    url: null,
    placeholder: null,
  }),
};

const bench = Layer.effect(
  Bench,
  Effect.gen(function* () {
    const engine = yield* Engine;
    const control = yield* TestEngine.TestEngineControl;

    const finish = (sessionId: SessionId, turnId: TurnId) =>
      control.finishTurn({ sessionId, turnId, outcome: { _tag: "completed" } });

    /** Holds the turn on `request`, and ends it once the request closes, as the agent would. */
    const holdOn = Effect.fnUntraced(function* (
      sessionId: SessionId,
      turnId: TurnId,
      held: EngineRequest,
    ) {
      const requestId = yield* control.openRequest({ sessionId, turnId, request: held });
      yield* engine.events({ sessionId, after: null }).pipe(
        Stream.filter((event) => event._tag === "request-closed" && event.requestId === requestId),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(finish(sessionId, turnId)),
        Effect.orDie,
        Effect.forkChild({ startImmediately: true }),
      );
    });

    const perform = ({
      sessionId,
      turnId,
      act,
    }: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly act: Act;
    }): Effect.Effect<void> => {
      switch (act._tag) {
        case "reply":
          return finish(sessionId, turnId);
        case "work":
          return Effect.void;
        case "approval":
        case "question":
        case "secret":
          return holdOn(sessionId, turnId, REQUESTS[act._tag]);
        case "speak":
          return control
            .hostSpeech({ sessionId, turnId, text: act.text })
            .pipe(Effect.andThen(finish(sessionId, turnId)));
      }
    };

    return Bench.of({
      workspacePath: "/bots/conformance",
      model: { providerId: ProviderId.make("test"), modelId: ModelId.make("test") },
      key: (name) => IdempotencyKey.make(name),
      // The double does nothing on its own, so the text only has to be distinct.
      prompt: (act) => `<j3-wake>${act._tag}</j3-wake>`,
      perform,
      readSteers: control.readSteers,
      startForeignTurn: (sessionId) => control.startEngineTurn(sessionId).pipe(Effect.asVoid),
    });
  }),
);

describe("Engine conformance", () => {
  layer(bench.pipe(Layer.provideMerge(TestEngine.layer)))("TestEngine", scenarios);
});
