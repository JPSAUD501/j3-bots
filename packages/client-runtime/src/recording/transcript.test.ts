// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { VoicePlace, VoiceSettings, VoiceStatus } from "@j3-bots/contracts";
import { VoiceModelId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionState } from "../connection/Connection.ts";
import { Cell } from "../Store.ts";
import type { Loaded } from "../stores/reads.ts";
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

/** What the server says while one piece is heard: the words held once `atMs` of it was. */
type Step = { readonly atMs: number; readonly committed: string; readonly tentative: string };

/** How one piece's dictation goes. */
type Plan =
  | { readonly heard: ReadonlyArray<Step>; readonly text: string; readonly timed?: false }
  | { readonly failed: DictationFailure };

/**
 * The server's speech recognition, faked: each dictation follows the next of
 * `plans`, answering every quarter second of audio as the engine does, and
 * says how many bytes each one took.
 */
const fakeServer = (plans: ReadonlyArray<Plan>) => {
  const fed: Array<number> = [];
  let opened = 0;
  const transcribe = Effect.sync((): Dictation => {
    const plan = plans[opened] ?? { failed: "failed" };
    opened += 1;
    const state = new Cell<DictationState>(
      "failed" in plan
        ? { _tag: "failed", reason: plan.failed }
        : { _tag: "listening", live: true, committed: "", tentative: "" },
    );
    let bytes = 0;
    return {
      state,
      audio: (pcm) =>
        Effect.sync(() => {
          if ("failed" in plan) return;
          bytes += pcm.byteLength;
          const heardMs = bytes / BYTES_PER_MS;
          const now = plan.heard.findLast((step) => step.atMs <= heardMs);
          const held = state.get();
          if (now === undefined || held._tag !== "listening") return;
          if (held.committed === now.committed && held.tentative === now.tentative) return;
          state.set({
            _tag: "listening",
            live: true,
            committed: now.committed,
            tentative: now.tentative,
            ...(plan.timed === false ? {} : { heardMs }),
          });
        }),
      finish: () =>
        Effect.sync(() => {
          if ("failed" in plan) return;
          fed.push(bytes);
          state.set({ _tag: "done", text: plan.text });
        }),
    };
  });
  return { transcribe, fed, opened: () => opened };
};

const settingsFor = (place: VoicePlace) =>
  new Cell(
    ready<{ readonly voice: VoiceSettings | null }>({
      voice: {
        place,
        language: "auto",
        words: [],
        removeFillers: true,
        cleanUp: false,
        model: null,
        openRouterModel: null,
      },
    }),
  );

const model = (installed: boolean) => ({
  id: VoiceModelId.make("test/streaming"),
  name: "Streaming",
  size: 751_000_000,
  languages: ["en", "pt"],
  live: true,
  errorPercent: {},
  secondsPer30s: 2.8,
  recommended: true,
  installed,
});

const services = (
  server: ReturnType<typeof fakeServer>,
  options: {
    readonly place?: VoicePlace;
    readonly status?: VoiceStatus;
    readonly takesTranscripts?: boolean;
    readonly connection?: Cell<ConnectionState>;
  } = {},
): TranscriptServices => ({
  takesTranscripts: new Cell(options.takesTranscripts ?? true),
  connection: options.connection ?? new Cell<ConnectionState>({ _tag: "connected" }),
  settings: settingsFor(options.place ?? "automatic"),
  voiceStatus: Effect.succeed(
    new Cell<Loaded<VoiceStatus>>(
      ready(options.status ?? { _tag: "available", model: model(true), installing: null }),
    ),
  ),
  transcribe: server.transcribe,
});

describe("writeDown", () => {
  it.effect(
    "cuts the voice where it is quietest and times each word from when the engine heard it",
    () =>
      Effect.gen(function* () {
        // 50 s of voice, silent from 24.0 to 24.3 s: the cut is in that silence.
        const speech = voice(50, [[24, 24.3]]);
        const server = fakeServer([
          {
            heard: [
              { atMs: 1000, committed: "", tentative: "open" },
              { atMs: 1500, committed: "open", tentative: "the invoice" },
              // The engine settled "invoice" as "invoices": heard then.
              { atMs: 2500, committed: "open the invoices", tentative: "" },
            ],
            text: "Open the invoices.",
          },
          {
            heard: [{ atMs: 3000, committed: "", tentative: "then send" }],
            // "it" came only with the final words, at the piece's end.
            text: "Then send it.",
          },
        ]);
        const shares: Array<number> = [];
        const transcript = yield* writeDown(services(server), speech, (done) => shares.push(done));

        assert.deepStrictEqual(server.fed, [24_050 * BYTES_PER_MS, 25_950 * BYTES_PER_MS]);
        assert.deepStrictEqual(transcript, {
          segments: [
            {
              t: 0,
              until: 24_050,
              text: "Open the invoices.",
              words: [
                { t: 1000, text: "Open" },
                { t: 1500, text: "the" },
                { t: 2500, text: "invoices." },
              ],
            },
            {
              t: 24_050,
              until: 50_000,
              text: "Then send it.",
              words: [
                { t: 27_050, text: "Then" },
                { t: 27_050, text: "send" },
                { t: 50_000, text: "it." },
              ],
            },
          ],
        });
        assert.isTrue(shares.every((share, index) => share >= (shares[index - 1] ?? 0)));
        assert.strictEqual(shares.at(-1), 1);
      }),
  );

  it.effect("keeps only the stretch's time where the words come at its end", () =>
    Effect.gen(function* () {
      const server = fakeServer([
        {
          heard: [{ atMs: 250, committed: "", tentative: "hi" }],
          text: "Hi there.",
          timed: false,
        },
      ]);
      const transcript = yield* writeDown(
        services(server, { place: "openai" }),
        voice(4),
        () => undefined,
      );
      assert.deepStrictEqual(transcript, {
        segments: [{ t: 0, until: 4000, text: "Hi there.", words: null }],
      });
    }),
  );

  it.effect("waits while another device dictates, then writes the piece down", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ failed: "busy" }, { heard: [], text: "Ready." }]);
      const fiber = yield* Effect.forkChild(
        writeDown(services(server), voice(2), () => undefined),
        { startImmediately: true },
      );
      yield* TestClock.adjust("3 seconds");
      const transcript = yield* Fiber.join(fiber);
      assert.strictEqual(server.opened(), 2);
      assert.deepStrictEqual(
        transcript?.segments.map((segment) => segment.text),
        ["Ready."],
      );
    }),
  );

  it.effect("waits for the connection to come back when a piece's link broke", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ failed: "unreachable" }, { heard: [], text: "Back." }]);
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
    "goes without, opening nothing, where dictation is off, no model is installed or the server is older",
    () =>
      Effect.gen(function* () {
        const server = fakeServer([]);
        const off = yield* writeDown(
          services(server, { place: "device" }),
          voice(2),
          () => undefined,
        );
        const noModel = yield* writeDown(
          services(server, {
            status: { _tag: "available", model: model(false), installing: null },
          }),
          voice(2),
          () => undefined,
        );
        const unsupported = yield* writeDown(
          services(server, { status: { _tag: "unavailable", reason: "platform" } }),
          voice(2),
          () => undefined,
        );
        const older = yield* writeDown(
          services(server, { takesTranscripts: false }),
          voice(2),
          () => undefined,
        );
        assert.deepStrictEqual([off, noModel, unsupported, older], [null, null, null, null]);
        assert.strictEqual(server.opened(), 0);
      }),
  );

  it.effect("goes without when the recognition fails for good", () =>
    Effect.gen(function* () {
      const server = fakeServer([{ failed: "cloud-key" }]);
      const transcript = yield* writeDown(
        services(server, { place: "xai" }),
        voice(2),
        () => undefined,
      );
      assert.isNull(transcript);
      assert.strictEqual(server.opened(), 1);
    }),
  );
});
