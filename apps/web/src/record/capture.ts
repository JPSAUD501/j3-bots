// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type FrameName,
  MAX_FRAME_BYTES,
  type RecordedScreen,
  type RecorderFailure,
  type RecorderJob,
  type ScreenNumber,
} from "@j3-bots/desktop-bridge";
import type { Desktop } from "../live/desktop";

// What the recorder's floating control does with a recording's streams
// (decision 0098): each screen through the browser's own H.264 encoder into
// fragmented MP4, the voice into Opus, a piece a second each, handed to the
// app in order as they are written; and a still of a screen whenever the app
// asks for one, at a click or a window change.

/** Frames a second each screen is drawn at: enough to follow a pointer, light on the disk. */
const FRAMES_PER_SECOND = 5;
/** How often each encoder hands over what it wrote, in ms. */
const PIECE = 1000;
/** A key frame at least this often, in ms, so any moment of a video opens quickly. */
const KEY_FRAME_EVERY = 2000;
const VIDEO_TYPE = "video/mp4;codecs=avc1";
const VIDEO_BITS = 900_000;
const VOICE_TYPE = "audio/webm;codecs=opus";
const VOICE_BITS = 48_000;
const STILL_QUALITY = 0.72;

/** Chromium's constraints for a screen's stream: its source, at most the size and pace given. */
interface DesktopVideo extends MediaTrackConstraints {
  readonly mandatory: {
    readonly chromeMediaSource: "desktop";
    readonly chromeMediaSourceId: string;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly maxFrameRate: number;
  };
}

/** Chromium's encoder options: the standard ones, and how often it writes a key frame. */
interface EncoderOptions extends MediaRecorderOptions {
  readonly videoKeyFrameIntervalDuration?: number;
}

type Recorder = Desktop["recorder"];

interface ScreenStream {
  /** The screen the job asked for. */
  readonly asked: RecordedScreen;
  readonly stream: MediaStream;
  /** Plays the stream off the page, for stills. */
  readonly video: HTMLVideoElement;
}

/** A recording under way. */
export interface Capture {
  /** The microphone's stream, for the level the control shows; `null` without a voice. */
  readonly voice: MediaStream | null;
  readonly pause: () => void;
  readonly resume: () => void;
  /**
   * Stops every encoder. `stop` waits for the last pieces to reach the app
   * and then tells it to keep the recording; `discard` tells it to throw it
   * away at once.
   */
  readonly finish: (how: "stop" | "discard") => Promise<void>;
  /** Hands the app a still of `screen` as it is now, as `name`. */
  readonly still: (screen: ScreenNumber, name: FrameName) => void;
}

export type CaptureStart =
  | { readonly _tag: "started"; readonly capture: Capture }
  | { readonly _tag: "failed"; readonly reason: RecorderFailure["reason"] };

const stopAll = (streams: ReadonlyArray<MediaStream>) => {
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
};

const screenStream = async (one: RecordedScreen): Promise<ScreenStream> => {
  const video: DesktopVideo = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: one.source,
      maxWidth: one.width,
      maxHeight: one.height,
      maxFrameRate: FRAMES_PER_SECOND,
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  const element = document.createElement("video");
  element.muted = true;
  element.srcObject = stream;
  await element.play();
  return { asked: one, stream, video: element };
};

const voiceStream = (microphone: string) =>
  navigator.mediaDevices.getUserMedia({
    audio: microphone === "default" ? true : { deviceId: { exact: microphone } },
    video: false,
  });

/** A video's size as the app takes it: whole pixels, the size asked for when the track does not say. */
const sizeOf = (stream: MediaStream, fallback: RecordedScreen) => {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const side = (value: number | undefined, other: number) =>
    value === undefined || !Number.isFinite(value) ? other : Math.max(2, Math.round(value));
  return {
    width: side(settings?.width, fallback.width),
    height: side(settings?.height, fallback.height),
  };
};

/**
 * Starts recording `job`: opens each screen's stream and the microphone's,
 * starts their encoders, and tells the app once all of them run. Answers why
 * it could not when one fails, having stopped whatever it had opened.
 */
export async function startCapture(job: RecorderJob, app: Recorder): Promise<CaptureStart> {
  if (!MediaRecorder.isTypeSupported(VIDEO_TYPE) || !MediaRecorder.isTypeSupported(VOICE_TYPE)) {
    return { _tag: "failed", reason: "encoder" };
  }
  const opened: Array<MediaStream> = [];
  const screens: Array<ScreenStream> = [];
  for (const one of job.screens) {
    try {
      const stream = await screenStream(one);
      opened.push(stream.stream);
      screens.push(stream);
    } catch {
      stopAll(opened);
      return { _tag: "failed", reason: "screen" };
    }
  }
  let voice: MediaStream | null = null;
  if (job.microphone !== null) {
    try {
      voice = await voiceStream(job.microphone);
      opened.push(voice);
    } catch {
      stopAll(opened);
      return { _tag: "failed", reason: "microphone" };
    }
  }

  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    stopAll(opened);
    app.failed("encoder");
  };

  /** Each encoder's pieces, handed over in the order it wrote them. */
  const encoders: Array<{ readonly recorder: MediaRecorder; handed: Promise<void> }> = [];
  const encode = (
    stream: MediaStream,
    options: EncoderOptions,
    hand: (bytes: Uint8Array) => void,
  ) => {
    const recorder = new MediaRecorder(stream, options);
    const encoder = { recorder, handed: Promise.resolve() };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      const piece = event.data;
      encoder.handed = encoder.handed
        .then(() => piece.arrayBuffer())
        .then((buffer) => hand(new Uint8Array(buffer)), fail);
    });
    recorder.addEventListener("error", fail);
    encoders.push(encoder);
    return recorder;
  };

  try {
    for (const one of screens) {
      encode(
        one.stream,
        {
          mimeType: VIDEO_TYPE,
          videoBitsPerSecond: VIDEO_BITS,
          videoKeyFrameIntervalDuration: KEY_FRAME_EVERY,
        },
        (bytes) => app.chunk({ stream: { _tag: "screen", screen: one.asked.screen }, bytes }),
      );
    }
    if (voice !== null) {
      encode(voice, { mimeType: VOICE_TYPE, audioBitsPerSecond: VOICE_BITS }, (bytes) =>
        app.chunk({ stream: { _tag: "voice" }, bytes }),
      );
    }
    await Promise.all(
      encoders.map(
        ({ recorder }) =>
          new Promise<void>((resolve) => {
            recorder.addEventListener("start", () => resolve(), { once: true });
            recorder.start(PIECE);
          }),
      ),
    );
  } catch {
    stopAll(opened);
    return { _tag: "failed", reason: "encoder" };
  }

  app.started({
    screens: screens.map((one) => ({
      screen: one.asked.screen,
      ...sizeOf(one.stream, one.asked),
    })),
    voice: voice !== null,
  });

  const each = (act: (recorder: MediaRecorder) => void) => {
    for (const { recorder } of encoders) if (recorder.state !== "inactive") act(recorder);
  };

  return {
    _tag: "started",
    capture: {
      voice,
      pause: () => {
        each((recorder) => recorder.pause());
        app.control("pause");
      },
      resume: () => {
        each((recorder) => recorder.resume());
        app.control("resume");
      },
      finish: async (how) => {
        const stopped = encoders.map(
          ({ recorder }) =>
            new Promise<void>((resolve) => {
              if (recorder.state === "inactive") resolve();
              else recorder.addEventListener("stop", () => resolve(), { once: true });
            }),
        );
        each((recorder) => recorder.stop());
        if (how === "discard") {
          stopAll(opened);
          app.control("discard");
          return;
        }
        // A recorder hands over its last piece before it says it stopped.
        await Promise.all(stopped);
        await Promise.all(encoders.map((encoder) => encoder.handed));
        stopAll(opened);
        app.control("stop");
      },
      still: (screen, name) => {
        const one = screens.find((candidate) => candidate.asked.screen === screen);
        if (one === undefined || one.video.videoWidth === 0) return;
        const canvas = new OffscreenCanvas(one.video.videoWidth, one.video.videoHeight);
        canvas.getContext("2d")?.drawImage(one.video, 0, 0);
        void canvas
          .convertToBlob({ type: "image/jpeg", quality: STILL_QUALITY })
          .then((blob) => blob.arrayBuffer())
          .then(
            (buffer) => {
              if (buffer.byteLength > 0 && buffer.byteLength <= MAX_FRAME_BYTES) {
                app.frame({ name, bytes: new Uint8Array(buffer) });
              }
            },
            // A still is a help, not the record: the video still has the moment.
            () => undefined,
          );
      },
    },
  };
}
