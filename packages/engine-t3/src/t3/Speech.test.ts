// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { streamOver } from "./Speech.ts";

/**
 * The engine's end of one speech stream, as `runSpeechSocket` answers at
 * `bc0f04d`: `ready` once started, one `update` per piece of audio, and
 * `finished` once finished; or `error` from `answers` when it says so.
 */
const fakeEngine = (answers: {
  readonly start: "ready" | "error";
  readonly updates: ReadonlyArray<{ committed: string; tentative: string } | null>;
  readonly finished: string;
}) =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<string>();
    const written: Array<string | Uint8Array> = [];
    let fed = 0;
    const answer = (chunk: string | Uint8Array): string => {
      if (typeof chunk !== "string") {
        const text = answers.updates[Math.min(fed, answers.updates.length - 1)] ?? null;
        fed += 1;
        return JSON.stringify({ type: "update", revision: fed, text });
      }
      const command: unknown = JSON.parse(chunk);
      const type =
        typeof command === "object" && command !== null && "type" in command ? command.type : null;
      if (type === "start") {
        return answers.start === "ready"
          ? JSON.stringify({ type: "ready" })
          : JSON.stringify({ type: "error", message: "Live transcription failed." });
      }
      return JSON.stringify({ type: "finished", text: answers.finished });
    };
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.take(incoming).pipe(Effect.map((message) => [message] as const)),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Effect.suspend(() => {
            if (Socket.isCloseEvent(chunk)) return Effect.void;
            written.push(chunk);
            return Queue.offer(incoming, answer(chunk)).pipe(Effect.asVoid);
          }),
        writeAll: () => Effect.void,
      }),
    });
    return { socket, written };
  });

const options = { language: "pt", words: ["Wren"], removeFillers: true };

describe("streamOver", () => {
  it.effect("starts with the options, feeds audio in order and finishes with the whole text", () =>
    Effect.gen(function* () {
      const engine = yield* fakeEngine({
        start: "ready",
        updates: [
          { committed: "olá", tentative: "Wr" },
          null,
          { committed: "olá Wren", tentative: "" },
        ],
        finished: "Olá Wren.",
      });
      const stream = yield* streamOver(engine.socket, options);
      const first = yield* stream.feed(new Uint8Array(8));
      // An update with nothing new keeps what was heard.
      const second = yield* stream.feed(new Uint8Array(8));
      const third = yield* stream.feed(new Uint8Array(8));
      const text = yield* stream.finish;

      assert.deepStrictEqual(first, { committed: "olá", tentative: "Wr" });
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(third, { committed: "olá Wren", tentative: "" });
      assert.strictEqual(text, "Olá Wren.");
      const start: unknown = JSON.parse(String(engine.written[0]));
      assert.deepStrictEqual(start, {
        type: "start",
        options: {
          speechLanguage: "pt",
          speechTranslateToEnglish: false,
          speechCustomWords: [{ term: "Wren", aliases: [] }],
          speechRemoveFillerWords: true,
          speechSilenceFiltering: true,
        },
      });
      assert.strictEqual(engine.written.filter((chunk) => chunk instanceof Uint8Array).length, 3);
      // Nothing more is taken once it is finished.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(stream.feed(new Uint8Array(8)))));
    }).pipe(Effect.scoped),
  );

  it.effect("fails when the engine refuses to start", () =>
    Effect.gen(function* () {
      const engine = yield* fakeEngine({ start: "error", updates: [], finished: "" });
      const exit = yield* Effect.exit(streamOver(engine.socket, options));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );
});
