// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { VoiceServerFrame } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { type DictationState, openDictation } from "./Voice.ts";

type Listener = (event: Socket.WebSocketEvent) => void;

/** A voice socket that is open at once, records what the client sends, and answers as told. */
const fakeSocket = () => {
  const listeners = new Map<string, Set<Listener>>();
  const sent: Array<string | number> = [];
  const socket: Socket.WebSocketLike = {
    readyState: 1,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    close: () => {},
    // Text frames as sent; a piece of audio as its first byte, which names it here.
    send: (data) => sent.push(typeof data === "string" ? data : (data[0] ?? -1)),
  };
  const answer = (frame: VoiceServerFrame) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ type: "message", data: JSON.stringify(frame) });
    }
  };
  return { socket, sent, answer };
};

/** Lets the dictation's own fiber take what just happened. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
});

/** A dictation over `fake`, and a piece of audio named by `name`. */
const dictation = (fake: ReturnType<typeof fakeSocket>) =>
  openDictation(Effect.succeed("ws://server.test/voice"), "1 second", false).pipe(
    Effect.provideService(Socket.WebSocketConstructor, () => fake.socket),
  );
const piece = (name: number) => new Uint8Array([name, 0, 0, 0]);
const START = JSON.stringify({ type: "start" });
const FINISH = JSON.stringify({ type: "finish" });

it.effect("sends what was recorded while the socket opened first, once the server listens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeSocket();
      const handle = yield* dictation(fake);
      yield* settle;
      yield* handle.audio(piece(1));
      yield* handle.audio(piece(2));
      assert.deepStrictEqual(fake.sent, [START]);

      fake.answer({ type: "listening", live: false });
      yield* settle;
      yield* handle.audio(piece(3));
      yield* handle.finish;
      assert.deepStrictEqual(fake.sent, [START, 1, 2, 3, FINISH]);
      assert.strictEqual(handle.state.get()._tag, "finishing");
    }),
  ),
);

it.effect("a Stop before the server listens still sends what was held, then finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeSocket();
      const handle = yield* dictation(fake);
      yield* settle;
      yield* handle.audio(piece(1));
      yield* handle.finish;
      // Recorded after Stop: not the operator's words.
      yield* handle.audio(piece(2));
      assert.strictEqual(handle.state.get()._tag, "finishing");

      fake.answer({ type: "listening", live: false });
      yield* settle;
      assert.deepStrictEqual(fake.sent, [START, 1, FINISH]);
      assert.strictEqual(handle.state.get()._tag, "finishing");

      fake.answer({ type: "done", text: "Book the venue" });
      yield* settle;
      const done: DictationState = { _tag: "done", text: "Book the venue" };
      assert.deepStrictEqual(handle.state.get(), done);
    }),
  ),
);
