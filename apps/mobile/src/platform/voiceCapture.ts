// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireOptionalNativeModule } from "expo";

// The app's own module (modules/voice-capture), on Android only: the
// microphone for dictation through the server, as the voice socket takes it.
// What it answers crosses from Kotlin, so each piece is checked before the
// app passes it on.

interface VoiceCaptureModule {
  start(): boolean;
  read(): Promise<unknown>;
  stop(): void;
}

const native = requireOptionalNativeModule<VoiceCaptureModule>("VoiceCapture");

/**
 * The microphone, recording mono 16 kHz 32-bit float PCM in little-endian
 * bytes, a piece of about 100 ms at a time. Null where the app has no such
 * module, as on iOS: dictation there cannot go through the server.
 */
export interface VoiceCapture {
  /** Opens the microphone, once the operator allowed it; false when it could not start. */
  readonly start: () => boolean;
  /** The next piece once it is recorded, or null once the recording is over. */
  readonly read: () => Promise<Uint8Array | null>;
  /** Lets the microphone go. */
  readonly stop: () => void;
}

export const voiceCapture: VoiceCapture | null =
  native === null
    ? null
    : {
        start: () => native.start(),
        read: () => native.read().then((piece) => (piece instanceof Uint8Array ? piece : null)),
        stop: () => native.stop(),
      };

/** A piece's samples, for its level. Its bytes are little-endian, as every Android device is. */
export const samplesOf = (piece: Uint8Array): Float32Array => {
  const whole = piece.byteLength - (piece.byteLength % Float32Array.BYTES_PER_ELEMENT);
  // A view needs its start aligned to a sample; a piece that is not gets copied.
  const bytes = piece.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? piece : piece.slice();
  return new Float32Array(bytes.buffer, bytes.byteOffset, whole / Float32Array.BYTES_PER_ELEMENT);
};
