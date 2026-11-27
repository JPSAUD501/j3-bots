// SPDX-License-Identifier: AGPL-3.0-or-later
// The audio worklet that records for dictation: the microphone's channels
// mixed to one, brought to the voice socket's rate and posted in pieces of a tenth of a
// second. Adapted from T3 Code v0.1.13, apps/web/src/speech/pcmWorklet.ts
// (Copyright (c) T3 Tools Inc., MIT license).
import { PCM_CAPTURE, PCM_PIECE } from "./pcmCapture";
import { PcmResampler } from "./pcmResampler";

// What an AudioWorkletGlobalScope has, which TypeScript's DOM library does not describe.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean;
  },
): void;

class PcmCapture extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private piece = new Float32Array(PCM_PIECE);
  private length = 0;

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const channels = inputs[0] ?? [];
    const first = channels[0];
    if (first === undefined) return true;
    const mono = new Float32Array(first.length);
    for (const channel of channels) {
      for (let index = 0; index < mono.length; index += 1) {
        mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length;
      }
    }
    for (const sample of this.resampler.push(mono)) {
      this.piece[this.length] = sample;
      this.length += 1;
      if (this.length === PCM_PIECE) {
        const full = this.piece;
        this.port.postMessage(full, [full.buffer]);
        this.piece = new Float32Array(PCM_PIECE);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor(PCM_CAPTURE, PcmCapture);
