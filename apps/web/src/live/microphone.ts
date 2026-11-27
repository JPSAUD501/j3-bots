// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MicrophoneOpening, OpenMicrophone } from "../components/Dictation";
import { PCM_CAPTURE } from "./pcmCapture";
import worklet from "./pcmCapture.worklet.ts?worker&url";

// The microphone for dictation in a browser and in the desktop app, opened
// in the same way as T3 Code's web capture (v0.1.13,
// apps/web/src/speech/browserPcmCapture.ts, MIT): `getUserMedia`, then an
// audio worklet that hands the page mono samples at the voice socket's rate.

/** Why the microphone did not open, from the error `getUserMedia` or the audio graph threw. */
const failureOf = (error: unknown): Extract<MicrophoneOpening, { _tag: "failed" }>["reason"] => {
  if (!(error instanceof DOMException)) return "failed";
  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-microphone";
    default:
      return "failed";
  }
};

/**
 * Opens the microphone, mono with the system's echo cancellation and noise
 * suppression, and records until `stop`: every track stopped and the audio
 * context closed, so the system's microphone indicator goes out at once.
 */
export const openMicrophone: OpenMicrophone = async (listener) => {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    return { _tag: "failed", reason: failureOf(error) };
  }
  const context = new AudioContext();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  const lost = () => {
    if (stopped) return;
    stop();
    listener.lost();
  };
  try {
    await context.audioWorklet.addModule(worklet);
    const node = new AudioWorkletNode(context, PCM_CAPTURE, { channelCount: 1 });
    node.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!stopped && event.data instanceof Float32Array) listener.samples(event.data);
    });
    node.port.start();
    node.addEventListener("processorerror", lost);
    for (const track of stream.getTracks()) track.addEventListener("ended", lost);
    context.createMediaStreamSource(stream).connect(node);
    // The worklet writes no output: connected, the graph runs, and nothing is heard.
    node.connect(context.destination);
    await context.resume();
  } catch (error) {
    stop();
    return { _tag: "failed", reason: failureOf(error) };
  }
  return { _tag: "open", stop };
};
