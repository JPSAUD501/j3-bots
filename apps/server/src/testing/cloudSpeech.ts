// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CloudVoiceProvider } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { CloudSpeech, type CloudSpeechFailed } from "../voice/CloudSpeech.ts";

/** One recording a fake provider heard, with the key it came with. */
export interface HeardRecording {
  readonly provider: CloudVoiceProvider;
  readonly key: string;
  readonly model: string | null;
  readonly bytes: number;
  readonly language: string;
}

/** How a fake provider answers a recording: its words, or why it gave none. */
export type CloudAnswer = Effect.Effect<string, CloudSpeechFailed>;

/** The cloud providers as a test plays them. No request leaves the process. */
export class TestCloudSpeech extends Context.Service<
  TestCloudSpeech,
  {
    /** Every recording sent, in order. */
    readonly heard: ReadonlyArray<HeardRecording>;
    /** How each recording from now on is answered; "Hello there." until set. */
    readonly answer: (answer: (heard: HeardRecording) => CloudAnswer) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/cloudSpeech/TestCloudSpeech") {}

/** Providers that hear "Hello there." in every recording and offer one OpenRouter model. */
export const layer = Layer.effectContext(
  Effect.sync(() => {
    const heard: Array<HeardRecording> = [];
    let answer = (_: HeardRecording): CloudAnswer => Effect.succeed("Hello there.");
    return Context.make(
      CloudSpeech,
      CloudSpeech.of({
        models: Effect.succeed([{ id: "openai/whisper-large-v3", name: "Whisper" }]),
        transcribe: (input) =>
          Effect.suspend(() => {
            const recording: HeardRecording = {
              provider: input.provider,
              key: Redacted.value(input.key),
              model: input.model,
              bytes: input.pcm.byteLength,
              language: input.options.language,
            };
            heard.push(recording);
            return answer(recording);
          }),
      }),
    ).pipe(
      Context.add(
        TestCloudSpeech,
        TestCloudSpeech.of({
          heard,
          answer: (next) =>
            Effect.sync(() => {
              answer = next;
            }),
        }),
      ),
    );
  }),
);
