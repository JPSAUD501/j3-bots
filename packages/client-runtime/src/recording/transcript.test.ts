// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { CloudVoiceProvider, VoicePlace, VoiceSettings } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionState } from "../connection/Connection.ts";
import { Cell } from "../Store.ts";
import { ready } from "../stores/synced.ts";
import type { Dictation, DictationFailure, DictationState } from "../stores/Voice.ts";
import { type RecordingSpeech, type TranscriptServices, writeDown } from "./transcript.ts";

const RATE = 16_000;
const BYTES_PER_MS = (RATE * 4) / 1000;

/**
 * `seconds` of voice at the voice socket's rate: a steady tone, with
 * silence over each of `quiet`, given in seconds.
 */
const voice = (
  seconds: number,
  quiet: ReadonlyArray<readonly [number, number]> = [],
): RecordingSpeech => {
  const samples = new Float32Array(seconds * RATE);
  for (let index = 0; index < samples.length; index += 1) {
    const at = index / RATE;
    samples[index] = quiet.some(([from, to]) => at >= from && at < to)
      ? 0
      : 0.4 * Math.sin((2 * Math.PI * 220 * index) / RATE);
  }
  const bytes = new Uint8Array(samples.buffer);
  return {
    size: bytes.byteLength,
    read: (start, end) => Promise.resolve(bytes.slice(start, end)),
  };
};

/** How one piece's dictation goes: the provider's words, or why it gave none. */
type Plan = { readonly text: string } | { readonly failed: DictationFailure };

/**
 * The server's dictation, faked: each one follows the next of `plans`, and
 * says how many bytes each took.
 */
const fakeServer = (plans: ReadonlyArray<Plan>) => {
  const fed: Array<number> = [];
  let opened = 0;
  const transcribe = Effect.sync((): Dictation => {
    const plan = plans[opened] ?? { failed: "failed" };
    opened += 1;
    const state = new Cell<DictationState>(
      "failed" in plan ? { _tag: "failed", reason: plan.failed } : { _tag: "listening" },
    );
    let bytes = 0;
    return {
      state,
      audio: (pcm) =>
        Effect.sync(() => {
          bytes += pcm.byteLength;
        }),
      finish: Effect.sync(() => {
        if ("failed" in plan) return;
        fed.push(bytes);
        state.set({ _tag: "done", text: plan.text });
      }),
    };
  });
  return { transcribe, fed, opened: () => opened };
};

const settingsFor = (place: VoicePlace, provider: CloudVoiceProvider | null | undefined) =>
  new Cell(
    ready<{ readonly voice: VoiceSettings | null }>({
      voice: {
        place,
        ...(provider === undefined ? {} : { provider }),
        language: "auto",
        words: [],
        removeFillers: true,
        cleanUp: false,
        model: null,
        openRouterModel: null,
      },
    }),
  );

const services = (
  server: ReturnType<typeof fakeServer>,
  options: {
    readonly place?: VoicePlace;
    readonly provider?: CloudVoiceProvider | null | undefined;
    readonly takesTranscripts?: boolean;
    readonly connection?: Cell<ConnectionState>;
  } = {},
): TranscriptServices => ({
  takesTranscripts: new Cell(options.takesTranscripts ?? true),
  connection: options.connection ?? new Cell<ConnectionState>({ _tag: "connected" }),
  settings: settingsFor(
    options.place ?? "automatic",
    "provider" in options ? options.provider : "openai",
  ),
  transcribe: server.transcribe,
});

describe("writeDown", () => {
  it.effect("cuts the voice where it is quietest and keeps each stretch's time", () =>
    Effect.gen(function* () {
      // 50 s of voice, silent from 24.0 to 24.3 s: the cut is in that silence.
      const speech = voice(50, [[24, 24.3]]);
      const server = fakeServer([{ text: "Open the invoices." }, { text: " Then send it. " }]);
      const shares: Array<number> = [];
      const transcript = yield* writeDown(services(server), speech, (done) => shares.push(done));

      assert.deepStrictEqual(server.fed, [24_050 * BYTES_PER_MS, 25_950 * BYTES_PER_MS]);
      assert.deepStrictEqual(transcript, {
        segments: [
          { t: 0, until: 24_050, text: "Open the invoices." },
          { t: 24_050, until: 50_000, text: "Then send it." },
        ],
      });
      assert.isTrue(shares.every((share, index) => share >= (shares[index - 1] ?? 0)));
      assert.strictEqual(shares.at(-1), 1);
    }),
  );

  it.effect("leaves out a stretch where nothing was said", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ text: "" }]);
      const transcript = yield* writeDown(services(server), voice(3), () => undefined);
      assert.deepStrictEqual(transcript, { segments: [] });
    }),
  );

  it.effect("waits for the connection to come back when a piece's link broke", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ failed: "unreachable" }, { text: "Back." }]);
      const connection = new Cell<ConnectionState>({ _tag: "offline" });
      const fiber = yield* Effect.forkChild(
        writeDown(services(server, { connection }), voice(2), () => undefined),
        { startImmediately: true },
      );
      // Offline for a minute: it does not try again meanwhile.
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(server.opened(), 1);
      connection.set({ _tag: "connected" });
      const transcript = yield* Fiber.join(fiber);
      assert.strictEqual(server.opened(), 2);
      assert.deepStrictEqual(
        transcript?.segments.map((segment) => segment.text),
        ["Back."],
      );
    }),
  );

  it.effect(
    "goes without, opening nothing, with no provider chosen, dictation kept on the phone or an older server",
    () =>
      Effect.gen(function* () {
        const server = fakeServer([]);
        const outcomes = yield* Effect.forEach(
          [
            services(server, { provider: null }),
            services(server, { place: "device" }),
            services(server, { provider: undefined }),
            services(server, { takesTranscripts: false }),
          ],
          (without) => writeDown(without, voice(2), () => undefined),
        );
        assert.deepStrictEqual(outcomes, [null, null, null, null]);
        assert.strictEqual(server.opened(), 0);
      }),
  );

  it.effect("goes without when the provider has no key or refuses it", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ failed: "cloud-key" }, { failed: "cloud-refused" }]);
      const keyless = yield* writeDown(services(server), voice(2), () => undefined);
      const refused = yield* writeDown(services(server), voice(2), () => undefined);
      assert.deepStrictEqual([keyless, refused], [null, null]);
      assert.strictEqual(server.opened(), 2);
    }),
  );
});
