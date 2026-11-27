// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Node's zlib has the CRC-32 every zip entry carries; Effect has none.
import * as NodeZlib from "node:zlib";
import { DeviceId, EntryTarget } from "@j3-bots/contracts";
import type { RecordingId, RecordingTranscript } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { type EventLine, linesText } from "./events.ts";
import { wholeFragments, wholeLines } from "./mp4.ts";
import {
  EVENTS_FILE,
  MANIFEST_FILE,
  manifestText,
  README_FILE,
  readmeOf,
  type RecordingFacts,
  screenFile,
  TRANSCRIPT_FILE,
  transcriptText,
  VOICE_FILE,
} from "./readme.ts";
import { readZip, type ZipEntry, type ZipLayout, zipLayout, type ZipTime } from "./zip.ts";

// Recordings on disk, one folder each under the app's `recordings/`, which
// hold exactly the files of the zip the page sends: each screen's video and
// the voice, appended as the encoders write them; `events.jsonl`, appended
// line by line; `frames/`; and, once the voice is written down,
// `transcript.json`. Beside them, out of the zip, `speech.pcm` keeps the
// voice at the voice socket's rate until it is written down, or it is
// settled that it will not be. `session.json` says what the recording is for
// and where it stands, and once it is finished, which files the zip holds and
// their checksums: the zip is never written whole (zip.ts).
//
// A recording the app did not finish (it crashed, or the computer went
// down) is finished the next time the app starts, from what was written:
// each video cut after its last whole fragment, the events after their
// last whole line. Nothing is lost but the second or so in flight.

const Rect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number.check(Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isGreaterThan(0)),
});
const Size = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});

const Entry = Schema.Struct({
  name: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  crc: Schema.Int,
});

/** What `session.json` holds. */
const Session = Schema.Struct({
  target: EntryTarget,
  pairing: DeviceId,
  startedAt: Schema.String,
  /** The local time it started, for the zip's entries. */
  local: Schema.Struct({
    year: Schema.Int,
    month: Schema.Int,
    day: Schema.Int,
    hour: Schema.Int,
    minute: Schema.Int,
    second: Schema.Int,
  }),
  timeZone: Schema.NullOr(Schema.String),
  appVersion: Schema.String,
  os: Schema.Struct({ platform: Schema.String, release: Schema.String }),
  input: Schema.Literals(["everything", "screen-and-voice"]),
  passwords: Schema.Literals(["hidden", "pause"]),
  screens: Schema.Array(Schema.Struct({ screen: Schema.Int, bounds: Rect, video: Size })),
  voice: Schema.Boolean,
  /** Set once it is finished. */
  finished: Schema.optionalKey(
    Schema.Struct({
      interrupted: Schema.Boolean,
      size: Schema.Int,
      entries: Schema.Array(Entry),
      /**
       * Set once it is settled whether the voice was written down: `added`
       * when the zip holds `transcript.json`, `none` when it goes without.
       * Absent while it waits for that, and from a version that wrote none.
       */
      transcript: Schema.optionalKey(Schema.Literals(["added", "none"])),
    }),
  ),
});
type Session = typeof Session.Type;
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(Session));
const encodeSession = Schema.encodeSync(Schema.fromJsonString(Session));

/** What a recording starts with. */
export type SessionStart = Omit<Session, "finished">;

/** A finished recording, ready to send. */
export interface Ready {
  readonly id: RecordingId;
  readonly target: EntryTarget;
  readonly pairing: DeviceId;
  readonly size: number;
  readonly startedAt: string;
  readonly interrupted: boolean;
  /** Bytes of the voice still to be written down for the transcript; null when none is. */
  readonly speech: number | null;
}

const SESSION_FILE = "session.json";
/** The voice at the voice socket's rate, for the transcript: never in the zip. */
const SPEECH_FILE = "speech.pcm";
/** Bytes of one sample of `SPEECH_FILE`. */
const SAMPLE_BYTES = 4;
const FRAMES = "frames";
/** How much of a file is read at once for its checksum or a range. */
const READ_STEP = 4 * 1024 * 1024;

const encoder = new TextEncoder();

/** The recordings under `folder`, which is the app's own. */
export const makeStore = Effect.fn("recording.store")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layouts = new Map<RecordingId, ZipLayout<string>>();

  const dir = (id: RecordingId) => path.join(folder, id);

  // Written beside it and renamed over it, so a quit while it is written
  // leaves the one before whole, and the recording with it.
  const writeSession = (id: RecordingId, session: Session) => {
    const file = path.join(dir(id), SESSION_FILE);
    return fs
      .writeFileString(`${file}.next`, encodeSession(session))
      .pipe(Effect.andThen(fs.rename(`${file}.next`, file)));
  };

  const sizeOf = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  /** Up to `length` bytes of `file` at `offset`. */
  const readAt = (file: string, offset: number, length: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file, { flag: "r" });
        const out = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          const chunk = yield* handle.readAlloc(Math.min(READ_STEP, length - got), {
            position: BigInt(offset + got),
          });
          if (Option.isNone(chunk) || chunk.value.length === 0) break;
          out.set(chunk.value, got);
          got += chunk.value.length;
        }
        return out.subarray(0, got);
      }),
    );

  const crcOf = Effect.fn("recording.crcOf")(function* (file: string, size: number) {
    let crc = 0;
    for (let at = 0; at < size; at += READ_STEP) {
      crc = NodeZlib.crc32(yield* readAt(file, at, Math.min(READ_STEP, size - at)), crc);
    }
    return crc;
  });

  /** Bytes of the voice kept for the transcript while it is unsettled; null otherwise. */
  const speechOf = Effect.fnUntraced(function* (id: RecordingId, session: Session) {
    if (session.finished?.transcript !== undefined) return null;
    const size = yield* sizeOf(path.join(dir(id), SPEECH_FILE));
    return size >= SAMPLE_BYTES ? size - (size % SAMPLE_BYTES) : null;
  });

  const readyOf = (id: RecordingId, session: Session, size: number, speech: number | null) =>
    ({
      id,
      target: session.target,
      pairing: session.pairing,
      size,
      startedAt: session.startedAt,
      interrupted: session.finished?.interrupted ?? true,
      speech,
    }) satisfies Ready;

  /**
   * Writes the explaining files, and the list of what the zip holds. The
   * checksums `known` has are taken as they are: a file the zip held before
   * is not read again.
   */
  const seal = Effect.fn("recording.seal")(function* (
    id: RecordingId,
    session: Session,
    ended: {
      readonly durationMs: number;
      readonly interrupted: boolean;
      readonly transcript?: "added" | "none";
    },
    known: ReadonlyArray<typeof Entry.Type> = [],
  ) {
    const root = dir(id);
    const screens: Array<Session["screens"][number]> = [];
    for (const screen of session.screens) {
      if ((yield* sizeOf(path.join(root, screenFile(screen.screen)))) > 0) screens.push(screen);
    }
    const voice = session.voice && (yield* sizeOf(path.join(root, VOICE_FILE))) > 0;
    const transcript = voice && ended.transcript === "added";
    const frames = (yield* fs
      .readDirectory(path.join(root, FRAMES))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
      .filter((name) => name.endsWith(".jpg"))
      .toSorted();
    const facts: RecordingFacts = {
      appVersion: session.appVersion,
      os: session.os,
      startedAt: session.startedAt,
      timeZone: session.timeZone,
      durationMs: ended.durationMs,
      interrupted: ended.interrupted,
      input: session.input,
      passwords: session.passwords,
      screens,
      voice,
      transcript,
      frames: frames.length,
    };
    yield* fs.writeFileString(path.join(root, MANIFEST_FILE), manifestText(facts));
    yield* fs.writeFileString(path.join(root, README_FILE), readmeOf(facts));
    const names = [
      README_FILE,
      MANIFEST_FILE,
      ...screens.map((screen) => screenFile(screen.screen)),
      ...(voice ? [VOICE_FILE] : []),
      ...(transcript ? [TRANSCRIPT_FILE] : []),
      EVENTS_FILE,
      ...frames.map((name) => `${FRAMES}/${name}`),
    ];
    const entries: Array<typeof Entry.Type> = [];
    for (const name of names) {
      const file = path.join(root, ...name.split("/"));
      const size = yield* sizeOf(file);
      const before = known.find((entry) => entry.name === name && entry.size === size);
      entries.push(before ?? { name, size, crc: yield* crcOf(file, size) });
    }
    const layout = layoutOf(id, session.local, entries);
    const sealed: Session = {
      ...session,
      finished: {
        interrupted: ended.interrupted,
        size: layout.size,
        entries,
        ...(ended.transcript === undefined ? {} : { transcript: ended.transcript }),
      },
    };
    yield* writeSession(id, sealed);
    layouts.set(id, layout);
    return readyOf(id, sealed, layout.size, yield* speechOf(id, sealed));
  });

  /** The recorded time: the stop line's, which is the events' last. */
  const durationOf = Effect.fnUntraced(function* (id: RecordingId) {
    const text = yield* fs
      .readFileString(path.join(dir(id), EVENTS_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const last = text.trimEnd().split("\n").at(-1);
    return last === undefined ? 0 : lastTime(last);
  });

  const layoutOf = (
    id: RecordingId,
    local: ZipTime,
    entries: ReadonlyArray<typeof Entry.Type>,
  ): ZipLayout<string> =>
    zipLayout(
      entries.map((entry): ZipEntry<string> => ({
        ...entry,
        source: path.join(dir(id), ...entry.name.split("/")),
      })),
      local,
    );

  const appendLines = (id: RecordingId, lines: ReadonlyArray<EventLine>) =>
    lines.length === 0
      ? Effect.void
      : fs.writeFile(path.join(dir(id), EVENTS_FILE), encoder.encode(linesText(lines)), {
          flag: "a",
        });

  /** Cuts what an interrupted recording left to what is whole; answers its recorded time. */
  const mend = Effect.fn("recording.mend")(function* (id: RecordingId, session: Session) {
    const root = dir(id);
    for (const screen of session.screens) {
      const file = path.join(root, screenFile(screen.screen));
      const size = yield* sizeOf(file);
      if (size === 0) continue;
      const keep = yield* wholeFragments(size, (offset, length) => readAt(file, offset, length));
      if (keep < size) yield* fs.truncate(file, keep);
    }
    // The voice kept for the transcript, to its last whole sample.
    const speech = path.join(root, SPEECH_FILE);
    const speechSize = yield* sizeOf(speech);
    if (speechSize % SAMPLE_BYTES !== 0) {
      yield* fs.truncate(speech, speechSize - (speechSize % SAMPLE_BYTES));
    }
    const events = path.join(root, EVENTS_FILE);
    const bytes = yield* fs.readFile(events).pipe(Effect.orElseSucceed(() => new Uint8Array()));
    const whole = wholeLines(bytes);
    if (whole < bytes.length) yield* fs.truncate(events, whole);
    const last = new TextDecoder().decode(bytes.subarray(0, whole)).trimEnd().split("\n").at(-1);
    const t = last === undefined ? 0 : lastTime(last);
    yield* appendLines(id, [{ t, type: "stop" }]);
    return t;
  });

  return {
    /** Starts a recording's folder. */
    begin: Effect.fn("recording.begin")(function* (id: RecordingId, start: SessionStart) {
      yield* fs.makeDirectory(path.join(dir(id), FRAMES), { recursive: true });
      yield* writeSession(id, start);
    }),
    /** Appends what an encoder wrote. */
    append: (
      id: RecordingId,
      stream: { readonly screen: number } | "voice" | "speech",
      bytes: Uint8Array,
    ) =>
      fs.writeFile(
        path.join(
          dir(id),
          stream === "voice"
            ? VOICE_FILE
            : stream === "speech"
              ? SPEECH_FILE
              : screenFile(stream.screen),
        ),
        bytes,
        { flag: "a" },
      ),
    appendLines,
    /** Keeps a picture, under its name in the zip. */
    frame: (id: RecordingId, name: string, bytes: Uint8Array) =>
      fs.writeFile(path.join(dir(id), ...name.split("/")), bytes),
    /**
     * Finishes a recording after `durationMs` recorded: `interrupted` when it
     * ended before the operator stopped it, as when its control went away.
     */
    finish: Effect.fn("recording.finish")(function* (
      id: RecordingId,
      durationMs: number,
      interrupted: boolean,
    ) {
      const read = yield* fs.readFileString(path.join(dir(id), SESSION_FILE));
      const session = decodeSession(read);
      if (Option.isNone(session)) return yield* Effect.fail("unreadable" as const);
      return yield* seal(id, session.value, { durationMs, interrupted });
    }),
    /** Deletes a recording: the operator discarded it, or the page sent it. */
    remove: (id: RecordingId) => {
      layouts.delete(id);
      return fs.remove(dir(id), { recursive: true }).pipe(Effect.ignore);
    },
    /**
     * Every recording kept: those finished, and those the app did not finish,
     * finished now from what they hold. A folder that cannot be read as a
     * recording is deleted.
     */
    recover: Effect.fn("recording.recover")(function* () {
      const ids = yield* fs
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const ready: Array<Ready> = [];
      for (const name of ids) {
        if (!isRecordingId(name)) continue;
        const id = name;
        const session = decodeSession(
          yield* fs
            .readFileString(path.join(dir(id), SESSION_FILE))
            .pipe(Effect.orElseSucceed(() => "")),
        );
        if (Option.isNone(session)) {
          yield* fs.remove(dir(id), { recursive: true }).pipe(Effect.ignore);
          continue;
        }
        const { finished } = session.value;
        if (finished !== undefined) {
          layouts.set(id, layoutOf(id, session.value.local, finished.entries));
          ready.push(readyOf(id, session.value, finished.size, yield* speechOf(id, session.value)));
          continue;
        }
        const durationMs = yield* mend(id, session.value);
        ready.push(yield* seal(id, session.value, { durationMs, interrupted: true }));
      }
      return ready;
    }),
    /** Bytes `[start, end)` of the voice kept for a recording's transcript; none once it is gone. */
    readSpeech: Effect.fn("recording.readSpeech")(function* (
      id: RecordingId,
      start: number,
      end: number,
    ) {
      const file = path.join(dir(id), SPEECH_FILE);
      if (!layouts.has(id) || end > (yield* sizeOf(file))) return Option.none<Uint8Array>();
      return Option.some(yield* readAt(file, start, end - start));
    }),
    /**
     * Puts `transcript` in a finished recording's zip, or settles with null
     * that it goes without one, and deletes the voice kept for it. Answers
     * the recording then; none once it is gone. Settled once: a second call
     * changes nothing.
     */
    keepTranscript: Effect.fn("recording.keepTranscript")(function* (
      id: RecordingId,
      transcript: RecordingTranscript | null,
    ) {
      if (!layouts.has(id)) return Option.none<Ready>();
      const session = decodeSession(yield* fs.readFileString(path.join(dir(id), SESSION_FILE)));
      if (Option.isNone(session) || session.value.finished === undefined) {
        return Option.none<Ready>();
      }
      const { finished } = session.value;
      if (finished.transcript !== undefined) {
        return Option.some(readyOf(id, session.value, finished.size, null));
      }
      const added = transcript !== null && transcript.segments.length > 0;
      if (added) {
        yield* fs.writeFileString(path.join(dir(id), TRANSCRIPT_FILE), transcriptText(transcript));
      }
      const ready = yield* seal(
        id,
        session.value,
        {
          durationMs: yield* durationOf(id),
          interrupted: finished.interrupted,
          transcript: added ? "added" : "none",
        },
        finished.entries.filter(
          (entry) => entry.name !== MANIFEST_FILE && entry.name !== README_FILE,
        ),
      );
      yield* fs.remove(path.join(dir(id), SPEECH_FILE)).pipe(Effect.ignore);
      return Option.some(ready);
    }),
    /** Bytes `[start, end)` of a finished recording's zip; none once it is gone. */
    read: Effect.fn("recording.read")(function* (id: RecordingId, start: number, end: number) {
      const layout = layouts.get(id);
      if (layout === undefined) return Option.none<Uint8Array>();
      return Option.some(
        yield* readZip(layout, start, end, (file, offset, length) =>
          readAt(file, offset, length).pipe(
            Effect.filterOrFail(
              (bytes) => bytes.length === length,
              () => "changed" as const,
            ),
          ),
        ),
      );
    }),
  };
});

const isRecordingId = (name: string): name is RecordingId => /^rec_[0-9a-z]{16}$/.test(name);

const LastTime = Schema.Struct({ t: Schema.Number });
const decodeLastTime = Schema.decodeUnknownOption(Schema.fromJsonString(LastTime));
const lastTime = (line: string) =>
  Option.match(decodeLastTime(line), { onNone: () => 0, onSome: ({ t }) => t });
