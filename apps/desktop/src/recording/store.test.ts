// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BotId, DeviceId } from "@j3-bots/contracts";
import type { RecordingId } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { unzipSync } from "fflate";
import { makeStore, type SessionStart } from "./store.ts";

const ID: RecordingId = "rec_0123456789abcdef";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const box = (type: string, body: number) => {
  const bytes = new Uint8Array(8 + body).fill(7);
  new DataView(bytes.buffer).setUint32(0, 8 + body);
  bytes.set(encoder.encode(type), 4);
  return bytes;
};
const join = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A fragmented MP4's header and two fragments, as an encoder writes them. */
const HEADER = join(box("ftyp", 24), box("moov", 600));
const FRAGMENT = join(box("moof", 100), box("mdat", 4000));

const START: SessionStart = {
  target: { _tag: "conversation", botId: BotId.make("bot_wren") },
  pairing: DeviceId.make("dev_desk"),
  startedAt: "2026-11-27T14:05:00.000Z",
  local: { year: 2026, month: 11, day: 27, hour: 11, minute: 5, second: 0 },
  timeZone: "America/Sao_Paulo",
  appVersion: "0.14.0",
  os: { platform: "linux", release: "6.8.0" },
  input: "everything",
  passwords: "pause",
  screens: [
    {
      screen: 1,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      video: { width: 1280, height: 720 },
    },
    {
      screen: 2,
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      video: { width: 1280, height: 720 },
    },
  ],
  voice: true,
};

/** The whole zip of a finished recording, read in pieces of `step` bytes, as the page does. */
const readWhole = (
  store: Effect.Success<ReturnType<typeof makeStore>>,
  size: number,
  step: number,
) =>
  Effect.gen(function* () {
    const parts: Array<Uint8Array> = [];
    for (let at = 0; at < size; at += step) {
      const part = yield* store.read(ID, at, at + step);
      parts.push(Option.getOrThrow(part));
    }
    return join(...parts);
  });

const recorded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-recordings-" });
  const store = yield* makeStore(folder);
  yield* store.begin(ID, START);
  yield* store.appendLines(ID, [{ t: 0, type: "start" }]);
  yield* store.append(ID, { screen: 1 }, HEADER);
  yield* store.append(ID, { screen: 1 }, FRAGMENT);
  yield* store.append(ID, { screen: 2 }, join(HEADER, FRAGMENT));
  yield* store.append(ID, "voice", encoder.encode("voice"));
  yield* store.frame(ID, "frames/000001200-s1.jpg", encoder.encode("jpeg"));
  yield* store.appendLines(ID, [
    { t: 1000, type: "text", until: 1100, text: "hi" },
    { t: 1200, type: "key", key: "Enter" },
  ]);
  return { folder, store };
});

describe("the recordings on disk", () => {
  it.effect(
    "give a zip of the recording's files with its manifest and README, read in any pieces",
    () =>
      Effect.gen(function* () {
        const { store } = yield* recorded;
        const ready = yield* store.finish(ID, 61_500, false);
        assert.strictEqual(ready.interrupted, false);
        const zip = yield* readWhole(store, ready.size, 1000);
        assert.strictEqual(zip.length, ready.size);
        const files = unzipSync(zip);
        assert.deepStrictEqual(Object.keys(files), [
          "README.md",
          "manifest.json",
          "screen-1.mp4",
          "screen-2.mp4",
          "voice.webm",
          "events.jsonl",
          "frames/000001200-s1.jpg",
        ]);
        assert.deepStrictEqual(files["screen-1.mp4"], join(HEADER, FRAGMENT));
        assert.strictEqual(decoder.decode(files["voice.webm"]), "voice");
        const manifest: unknown = JSON.parse(decoder.decode(files["manifest.json"]));
        assert.deepInclude(manifest, {
          startedAt: "2026-11-27T14:05:00.000Z",
          timeZone: "America/Sao_Paulo",
          durationMs: 61_500,
          interrupted: false,
          voice: { file: "voice.webm", codec: "opus" },
          transcript: null,
          frames: 1,
        });
        assert.deepInclude((manifest as { readonly screens: ReadonlyArray<unknown> }).screens[0], {
          screen: 1,
          file: "screen-1.mp4",
          scale: 0.5,
        });
        // Past its end, nothing more.
        assert.strictEqual(
          Option.getOrThrow(yield* store.read(ID, ready.size, ready.size + 10)).length,
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finish a recording the app did not, from its whole fragments and lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { folder, store } = yield* recorded;
      // The app went down while writing: half a fragment and half a line.
      yield* store.append(ID, { screen: 1 }, FRAGMENT.subarray(0, 2000));
      yield* fs.writeFile(path.join(folder, ID, "events.jsonl"), encoder.encode('{"t":15'), {
        flag: "a",
      });

      const again = yield* makeStore(folder);
      const [ready] = yield* again.recover();
      assert.isDefined(ready);
      assert.strictEqual(ready?.interrupted, true);
      const files = unzipSync(yield* readWhole(again, ready?.size ?? 0, 4096));
      assert.deepStrictEqual(files["screen-1.mp4"], join(HEADER, FRAGMENT));
      assert.deepStrictEqual(
        decoder.decode(files["events.jsonl"]).trimEnd().split("\n").slice(-2),
        ['{"t":1200,"type":"key","key":"Enter"}', '{"t":1200,"type":"stop"}'],
      );
      assert.deepInclude(JSON.parse(decoder.decode(files["manifest.json"])), {
        durationMs: 1200,
        interrupted: true,
      });

      // Kept as finished: the next start offers it as it is.
      const third = yield* makeStore(folder);
      assert.deepStrictEqual(yield* third.recover(), [ready]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "put the transcript in the zip once the voice is written down, and drop the voice kept for it",
    () =>
      Effect.gen(function* () {
        const { folder, store } = yield* recorded;
        const speech = new Uint8Array(new Float32Array([0, 0.25, -0.25, 0.5]).buffer);
        yield* store.append(ID, "speech", speech);
        yield* store.appendLines(ID, [{ t: 61_500, type: "stop" }]);
        const ready = yield* store.finish(ID, 61_500, false);
        assert.strictEqual(ready.speech, 16);
        assert.deepStrictEqual(Option.getOrThrow(yield* store.readSpeech(ID, 0, 16)), speech);

        const kept = Option.getOrThrow(
          yield* store.keepTranscript(ID, {
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
              { t: 24_050, until: 50_000, text: "Then send it.", words: null },
            ],
          }),
        );
        assert.isNull(kept.speech);
        assert.isAbove(kept.size, ready.size);
        const files = unzipSync(yield* readWhole(store, kept.size, 1000));
        assert.deepStrictEqual(Object.keys(files), [
          "README.md",
          "manifest.json",
          "screen-1.mp4",
          "screen-2.mp4",
          "voice.webm",
          "transcript.json",
          "events.jsonl",
          "frames/000001200-s1.jpg",
        ]);
        assert.deepStrictEqual(files["screen-1.mp4"], join(HEADER, FRAGMENT));
        assert.deepStrictEqual(JSON.parse(decoder.decode(files["transcript.json"])), {
          format: "j3-bots-screen-recording-transcript",
          version: 1,
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
            { t: 24_050, until: 50_000, text: "Then send it." },
          ],
        });
        assert.deepInclude(JSON.parse(decoder.decode(files["manifest.json"])), {
          durationMs: 61_500,
          transcript: "transcript.json",
        });
        const readme = decoder.decode(files["README.md"]);
        assert.include(readme, "`transcript.json`: what they said");
        assert.include(readme, "## Transcript");
        // The voice kept for it is gone, and the next start offers the zip as it is now.
        assert.isTrue(Option.isNone(yield* store.readSpeech(ID, 0, 16)));
        assert.deepStrictEqual(yield* (yield* makeStore(folder)).recover(), [kept]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("go without a transcript when the voice is not written down, and say so", () =>
    Effect.gen(function* () {
      const { store } = yield* recorded;
      yield* store.append(ID, "speech", new Uint8Array(16));
      yield* store.appendLines(ID, [{ t: 61_500, type: "stop" }]);
      const ready = yield* store.finish(ID, 61_500, false);

      const kept = Option.getOrThrow(yield* store.keepTranscript(ID, null));
      assert.strictEqual(kept.size, ready.size);
      assert.isNull(kept.speech);
      // Settled: a transcript that comes later is not added.
      const later = Option.getOrThrow(
        yield* store.keepTranscript(ID, {
          segments: [{ t: 0, until: 1000, text: "Hello.", words: null }],
        }),
      );
      assert.strictEqual(later.size, ready.size);
      const files = unzipSync(yield* readWhole(store, kept.size, 1000));
      assert.notProperty(files, "transcript.json");
      assert.deepInclude(JSON.parse(decoder.decode(files["manifest.json"])), { transcript: null });
      assert.include(decoder.decode(files["README.md"]), "There is no transcript");
      assert.isTrue(Option.isNone(yield* store.readSpeech(ID, 0, 16)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drop a video that never got its header whole", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-recordings-" });
      const store = yield* makeStore(folder);
      yield* store.begin(ID, START);
      // The app went down before screen 1's encoder had written its header.
      yield* store.append(ID, { screen: 1 }, HEADER.subarray(0, 300));
      yield* store.append(ID, { screen: 2 }, join(HEADER, FRAGMENT));
      const again = yield* makeStore(folder);
      const [ready] = yield* again.recover();
      const files = unzipSync(yield* readWhole(again, ready?.size ?? 0, 65_536));
      assert.deepStrictEqual(
        Object.keys(files).filter((name) => name.endsWith(".mp4")),
        ["screen-2.mp4"],
      );
      assert.deepStrictEqual(
        (
          JSON.parse(decoder.decode(files["manifest.json"])) as {
            readonly screens: ReadonlyArray<{ readonly screen: number }>;
          }
        ).screens.map((screen) => screen.screen),
        [2],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
