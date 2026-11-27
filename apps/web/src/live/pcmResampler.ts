// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from T3 Code v0.1.13, apps/web/src/speech/pcmResampler.ts (MIT License,
// Copyright (c) T3 Tools Inc.).
import { PCM_RATE } from "./pcmCapture";

/** Taps of the low-pass filter applied before downsampling. */
const TAPS = 63;
/** Where the filter starts to cut, under half of `PCM_RATE`, so nothing folds back into speech. */
const CUTOFF_HZ = 7_200;

/**
 * Turns a microphone's samples into the voice socket's rate: a windowed-sinc
 * low-pass, then one sample kept every `rate / 16 kHz`. The filter's history
 * and the phase of the samples kept carry across pieces, so the pieces it is
 * fed join without a seam.
 */
export class PcmResampler {
  private readonly coefficients: Float64Array;
  private readonly history: Float32Array;
  private readonly ratio: number;
  private position = 0;
  private phase = 0;

  constructor(sampleRate: number) {
    if (sampleRate < PCM_RATE) throw new RangeError("The microphone's rate is too low.");
    this.ratio = sampleRate / PCM_RATE;
    this.coefficients = new Float64Array(sampleRate === PCM_RATE ? 1 : TAPS);
    this.history = new Float32Array(this.coefficients.length);
    const middle = (this.coefficients.length - 1) / 2;
    const cutoff = CUTOFF_HZ / sampleRate;
    let sum = 0;
    for (let tap = 0; tap < this.coefficients.length; tap += 1) {
      const x = tap - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = middle === 0 ? 1 : 0.54 - 0.46 * Math.cos((Math.PI * tap) / middle);
      const coefficient = sinc * window;
      this.coefficients[tap] = coefficient;
      sum += coefficient;
    }
    for (let tap = 0; tap < this.coefficients.length; tap += 1) {
      this.coefficients[tap] = (this.coefficients[tap] ?? 0) / sum;
    }
  }

  /** The samples at the voice socket's rate that `samples` give, after those fed before. */
  push(samples: Float32Array): Float32Array {
    const output: Array<number> = [];
    const length = this.history.length;
    for (const sample of samples) {
      this.history[this.position] = sample;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = 0;
        for (let tap = 0; tap < length; tap += 1) {
          value +=
            (this.history[(this.position - tap + length) % length] ?? 0) *
            (this.coefficients[tap] ?? 0);
        }
        output.push(Math.max(-1, Math.min(1, value)));
      }
      this.position = (this.position + 1) % length;
    }
    return Float32Array.from(output);
  }
}
