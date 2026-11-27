// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, EntryTarget } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// A screen recording (decision 0098): the sheet in the app's window that
// starts one, the floating control that records, and the zip the app hands
// back to the page to send. The control is the web client's own page at
// `RECORDER_PATH`, in a window of its own: it holds the screens' and the
// microphone's streams and their encoders, and sends what they write to the
// main process, which keeps it on disk and adds the keys, clicks and windows
// it reads itself.

/** The path of the app's page the recorder's floating control shows. */
export const RECORDER_PATH = "/record";

/** The most screens one recording takes. */
export const MAX_RECORDED_SCREENS = 16;

/** A screen of a recording, from 1, as its file `screen-<n>.mp4` names it. */
export const ScreenNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_RECORDED_SCREENS }),
);
export type ScreenNumber = typeof ScreenNumber.Type;

/**
 * A system permission recording needs, as it stands: `granted`, `needed`
 * (the operator gives it in the system's settings), or `not-needed` where
 * the system asks for none.
 */
export const RecordingAccess = Schema.Literals(["granted", "needed", "not-needed"]);
export type RecordingAccess = typeof RecordingAccess.Type;

/** What the sheet shows before a recording starts. */
export const RecordingCheck = Schema.Struct({
  /**
   * What is recorded here: `everything` (the screens, the voice, keys and
   * clicks), or `screen-and-voice` where the system lets no app read keys
   * and clicks (Wayland).
   */
  input: Schema.Literals(["everything", "screen-and-voice"]),
  /**
   * Whether the system says when a password is typed, so the app records
   * only that one was (`hidden`: macOS, Windows), or the operator pauses
   * before typing one (`pause`).
   */
  passwords: Schema.Literals(["hidden", "pause"]),
  /** macOS's Screen Recording. */
  screen: RecordingAccess,
  /** macOS's Accessibility, which reading keys and clicks needs. */
  keys: RecordingAccess,
  /** Whether the computer's disk has room for a long recording. */
  space: Schema.Literals(["enough", "low"]),
  /** A recording is under way, or being finished. */
  busy: Schema.Boolean,
});
export type RecordingCheck = typeof RecordingCheck.Type;

/** Opens where the operator gives a permission the check says is `needed`. Answers `RecordingCheck`. */
export const RecordingAccessRequest = Schema.Struct({
  access: Schema.Literals(["screen", "keys"]),
});
export type RecordingAccessRequest = typeof RecordingAccessRequest.Type;

/** A microphone, by the id the page's media devices give it. */
const MicrophoneId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

/**
 * Starts recording, once the sheet counted down: for the conversation or
 * room `target`, under `pairing`, with the microphone the operator picked
 * (`null`: none, or the system's default when `microphone` is `default`).
 */
export const RecordingStart = Schema.Struct({
  target: EntryTarget,
  pairing: DeviceId,
  microphone: Schema.NullOr(MicrophoneId),
});
export type RecordingStart = typeof RecordingStart.Type;

/**
 * How asking to record ended: `started`, `busy` with another, refused for
 * want of disk `space`, or `failed` to start.
 */
export const RecordingStartResult = Schema.Literals(["started", "busy", "space", "failed"]);
export type RecordingStartResult = typeof RecordingStartResult.Type;

/** Asks the main window to open the sheet on `target`, from quick access or a bot's offer. */
export const RecordingOpen = Schema.Struct({ target: EntryTarget, pairing: DeviceId });
export type RecordingOpen = typeof RecordingOpen.Type;

const Pixels = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 7680 }));

/** A screen the control records: the system's source for it, and the size its video is drawn at. */
export const RecordedScreen = Schema.Struct({
  screen: ScreenNumber,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  width: Pixels,
  height: Pixels,
});
export type RecordedScreen = typeof RecordedScreen.Type;

/** What the control records, which it asks for as its page loads. */
export const RecorderJob = Schema.Struct({
  target: EntryTarget,
  pairing: DeviceId,
  microphone: Schema.NullOr(MicrophoneId),
  screens: Schema.Array(RecordedScreen).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_RECORDED_SCREENS),
  ),
});
export type RecorderJob = typeof RecorderJob.Type;

/**
 * The control's encoders started: the size each screen's video really has,
 * and whether the voice is recorded. The recording's clock starts here.
 */
export const RecorderStarted = Schema.Struct({
  screens: Schema.Array(
    Schema.Struct({ screen: ScreenNumber, width: Pixels, height: Pixels }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECORDED_SCREENS)),
  voice: Schema.Boolean,
});
export type RecorderStarted = typeof RecorderStarted.Type;

/** The most bytes one piece an encoder wrote may carry across the bridge. */
export const MAX_RECORDER_CHUNK = 64 * 1024 * 1024;

/** What an encoder wrote next: a screen's video, or the voice. Pieces of one stream arrive in order. */
export const RecorderChunk = Schema.Struct({
  stream: Schema.Union([
    Schema.TaggedStruct("screen", { screen: ScreenNumber }),
    Schema.TaggedStruct("voice", {}),
  ]),
  bytes: Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECORDER_CHUNK)),
});
export type RecorderChunk = typeof RecorderChunk.Type;

/** A picture's name in the zip: `frames/<ms into the recording, nine digits>-s<screen>.jpg`. */
export const FrameName = Schema.String.check(Schema.isPattern(/^frames\/\d{9}-s\d{1,2}\.jpg$/));
export type FrameName = typeof FrameName.Type;

/** The most bytes a picture at a click or a window change may have. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** A picture the main process asked for (`RecorderCue` `frame`), as a JPEG. */
export const RecorderFrame = Schema.Struct({
  name: FrameName,
  bytes: Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FRAME_BYTES)),
});
export type RecorderFrame = typeof RecorderFrame.Type;

/**
 * What the operator pressed on the control. `stop` and `discard` come once
 * the encoders stopped, after the last piece they wrote.
 */
export const RecorderControl = Schema.Struct({
  action: Schema.Literals(["pause", "resume", "stop", "discard"]),
});
export type RecorderControl = typeof RecorderControl.Type;

/** The control could not record: the screens, the microphone, or its encoder failed. */
export const RecorderFailure = Schema.Struct({
  reason: Schema.Literals(["screen", "microphone", "encoder"]),
});
export type RecorderFailure = typeof RecorderFailure.Type;

/**
 * What the main process asks of the control: a picture of a screen as it is
 * now (`frame`); that the disk runs low (`space`); or to stop, keeping what
 * it recorded (`stop`), as when the disk is nearly full.
 */
export const RecorderCue = Schema.Union([
  Schema.TaggedStruct("frame", { screen: ScreenNumber, name: FrameName }),
  Schema.TaggedStruct("space", { state: Schema.Literals(["low", "enough"]) }),
  Schema.TaggedStruct("stop", {}),
]);
export type RecorderCue = typeof RecorderCue.Type;

/** A finished recording the app keeps until the page releases it. */
export const RecordingId = Schema.String.check(Schema.isPattern(/^rec_[0-9a-z]{16}$/));
export type RecordingId = typeof RecordingId.Type;

/**
 * A recording for the page: `ready`, the zip of `size` bytes to put in the
 * draft of `target` under `pairing`, started at `startedAt`; `interrupted`
 * when the app stopped before the operator did, and it was put together
 * from what was written. `failed`: it could not record, and nothing was kept.
 * `discarded`: the operator threw it away. Either way the app's window is
 * back.
 */
export const RecordingDelivery = Schema.Union([
  Schema.TaggedStruct("ready", {
    id: RecordingId,
    target: EntryTarget,
    pairing: DeviceId,
    size: Schema.Int.check(Schema.isGreaterThan(0)),
    startedAt: Schema.DateTimeUtcFromString,
    interrupted: Schema.Boolean,
  }),
  Schema.TaggedStruct("failed", {
    target: EntryTarget,
    reason: Schema.Literals(["screen", "microphone", "encoder", "space", "storage"]),
  }),
  Schema.TaggedStruct("discarded", { target: EntryTarget }),
]);
export type RecordingDelivery = typeof RecordingDelivery.Type;

/** The most bytes the page reads of a recording at once. */
export const MAX_RECORDING_READ = 16 * 1024 * 1024;

/** Bytes `[start, end)` of a ready recording's zip. Answers the bytes, or `null` once it is gone. */
export const RecordingRead = Schema.Struct({
  id: RecordingId,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Int.check(Schema.isGreaterThan(0)),
}).check(
  Schema.makeFilter(({ start, end }) => end > start && end - start <= MAX_RECORDING_READ, {
    title: "a range of at most MAX_RECORDING_READ bytes",
  }),
);
export type RecordingRead = typeof RecordingRead.Type;

/** The page no longer needs the recording: the app deletes it. */
export const RecordingRelease = Schema.Struct({ id: RecordingId });
export type RecordingRelease = typeof RecordingRelease.Type;
