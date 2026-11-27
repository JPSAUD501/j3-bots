// SPDX-License-Identifier: AGPL-3.0-or-later

/** How loud a sound is now, 0 (silence) to 1, read until `close`. */
interface LevelReading {
  readonly read: () => number;
  readonly close: () => void;
}

/** A sound whose level can be read: each `open` reads it until closed. */
export interface Level {
  readonly open: () => LevelReading;
}

// Speech sits between about -50 and -10 dBFS; the bars span that, so a
// quiet voice still moves them and a loud one fills them.
const FLOOR_DB = -55;
const CEILING_DB = -8;

/** The level of the first audio track of `stream`, from its waveform's RMS. */
export const streamLevel = (stream: MediaStream): Level => ({
  open: () => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      read: () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        if (rms === 0) return 0;
        const db = 20 * Math.log10(rms);
        return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
      },
      close: () => {
        source.disconnect();
        void context.close();
      },
    };
  },
});
