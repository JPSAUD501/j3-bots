// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import type { ViewerOutput } from "../Browser.ts";
import { viewerOf } from "./BrowserBridge.ts";

type Incoming = Uint8Array | string | { readonly close: number; readonly reason?: string };

/**
 * The engine's end of one preview stream: what the test makes it send, and
 * every message the viewer wrote to it.
 */
const fakeStream = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<Incoming>();
  const written: Array<string> = [];
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(incoming).pipe(
        Effect.flatMap((message) =>
          typeof message === "string" || message instanceof Uint8Array
            ? Effect.succeed([message] as const)
            : Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketCloseError({
                    code: message.close,
                    ...(message.reason === undefined ? {} : { closeReason: message.reason }),
                  }),
                }),
              ),
        ),
      ),
      upgrade: () => Effect.void,
    }),
    writer: Effect.succeed({
      write: (chunk) =>
        Effect.sync(() => {
          if (typeof chunk === "string") written.push(chunk);
        }),
      writeAll: () => Effect.void,
    }),
  });
  return { incoming, written, viewer: yield* viewerOf(socket) };
});

const outputsUntilClosed = (output: Stream.Stream<ViewerOutput, unknown>) =>
  output.pipe(Stream.runCollect, Effect.exit);

describe("viewerOf", () => {
  it.effect("passes on pictures and the frames it knows, and drops everything else", () =>
    Effect.gen(function* () {
      const { incoming, viewer } = yield* fakeStream;
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      yield* Queue.offerAll(incoming, [
        jpeg,
        JSON.stringify({ type: "pointer", phase: "click", x: 1, y: 2, sequence: 1 }),
        // The clipboard, a download and a file picker are not passed on.
        JSON.stringify({ type: "clipboard", text: "copied password" }),
        JSON.stringify({ type: "download", id: "d", fileName: "a.pdf", sizeBytes: 1 }),
        JSON.stringify({ type: "fileChooser", id: "c", multiple: false, accept: "" }),
        // A frame it knows that does not decode, and text that is not JSON.
        JSON.stringify({ type: "viewport", width: "wide", height: 800 }),
        "not json",
        JSON.stringify({ type: "viewport", width: 1280, height: 800 }),
        JSON.stringify({
          type: "control",
          canOperate: true,
          controller: "another-viewer",
          generation: 3,
          dialog: { type: "prompt", message: "Name?", defaultValue: "" },
        }),
        JSON.stringify({ type: "probe", x: 10, y: 20, editable: true }),
      ]);
      const outputs = yield* viewer.output.pipe(Stream.take(5), Stream.runCollect);
      assert.deepStrictEqual(outputs, [
        { _tag: "frame", jpeg },
        { _tag: "cursor", action: "click", x: 1, y: 2 },
        { _tag: "viewport", width: 1280, height: 800 },
        {
          _tag: "control",
          controller: "another-viewer",
          generation: 3,
          dialog: { kind: "prompt", message: "Name?", defaultValue: "" },
        },
        { _tag: "probe", x: 10, y: 20, editable: true },
      ]);
    }),
  );

  it.effect("ends with why the engine closed the stream", () =>
    Effect.gen(function* () {
      const reasons = [
        [{ close: 4404, reason: "tab closed" }, { reason: "gone" }],
        [
          {
            close: 4503,
            reason: JSON.stringify({ need: "libraries", command: "t3 browser setup" }),
          },
          { reason: "setup-needed", need: "libraries" },
        ],
        [{ close: 1012, reason: "reconnect" }, { reason: "reconnect" }],
        [{ close: 1006 }, { reason: "lost" }],
      ] as const;
      for (const [close, expected] of reasons) {
        const { incoming, viewer } = yield* fakeStream;
        yield* Queue.offer(incoming, close);
        const exit = yield* outputsUntilClosed(viewer.output);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
          assert.deepInclude(error?._tag === "Fail" ? error.error : {}, expected);
        }
      }
    }),
  );

  it.effect("writes input in the engine's terms", () =>
    Effect.gen(function* () {
      const { written, viewer } = yield* fakeStream;
      yield* viewer.ack;
      yield* viewer.send({ type: "take" });
      yield* viewer.send({
        type: "pointer",
        action: "down",
        x: 4,
        y: 5,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      });
      yield* viewer.send({ type: "text", text: "hello" });
      yield* viewer.send({ type: "back" });
      yield* viewer.send({ type: "release" });
      assert.deepStrictEqual(
        written.map((message) => JSON.parse(message)),
        [
          { type: "ack" },
          { type: "takeControl" },
          {
            type: "mouse",
            action: "down",
            x: 4,
            y: 5,
            button: "left",
            buttons: 1,
            clickCount: 1,
            modifiers: 0,
          },
          { type: "text", text: "hello" },
          { type: "history", delta: -1 },
          { type: "releaseControl" },
        ],
      );
    }),
  );
});
