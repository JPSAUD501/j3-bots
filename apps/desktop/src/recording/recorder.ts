// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ShellCommand } from "@j3-bots/desktop-bridge";
import {
  IPC_CHANNELS,
  RECORDER_PATH,
  RecorderChunk,
  RecorderControl,
  RecorderCue,
  RecorderFailure,
  RecorderFrame,
  type RecorderJob,
  RecorderStarted,
  type RecordingCheck,
  RecordingAccessRequest,
  RecordingDelivery,
  RecordingOpen,
  RecordingRead,
  RecordingRelease,
  RecordingStart,
  type RecordingStartResult,
  type RecordingId,
  RecorderJob as RecorderJobSchema,
} from "@j3-bots/desktop-bridge";
import { freeSpaceAt } from "@j3-bots/server/free-space";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  type Display,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  screen,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import type { WindowReader } from "../lookingAt/index.ts";
import { type EventLine, makeEvents, type Output } from "./events.ts";
import { hookBinary, listenToInput } from "./input.ts";
import type { System } from "./keys.ts";
import { type RecordedScreen, videoSize } from "./screens.ts";
import { passwordsHere, watchSecureInput } from "./secureInput.ts";
import { makeStore, type Ready } from "./store.ts";

// Screen recordings (decision 0098). The sheet in the app's window asks to
// start; the app hides its windows and shows the floating control, a small
// window above all others that the page at `RECORDER_PATH` draws. That page
// records each screen and the microphone with the browser's own encoders
// (H.264 in fragmented MP4, Opus in WebM) and sends each piece they write
// here, where it is appended to the recording's folder at once (store.ts).
// The app adds what it reads itself: keys, clicks and the wheel (input.ts),
// the window in front, once a second (the quick access reader), whether a
// password is being typed (secureInput.ts). On Stop the app finishes the
// recording, shows its window again and hands the page the zip to send,
// which it keeps until the page releases it, across restarts too.

const decodeStart = Schema.decodeUnknownOption(RecordingStart);
const decodeOpen = Schema.decodeUnknownOption(RecordingOpen);
const decodeAccess = Schema.decodeUnknownOption(RecordingAccessRequest);
const decodeStarted = Schema.decodeUnknownOption(RecorderStarted);
const decodeChunk = Schema.decodeUnknownOption(RecorderChunk);
const decodeFrame = Schema.decodeUnknownOption(RecorderFrame);
const decodeControl = Schema.decodeUnknownOption(RecorderControl);
const decodeFailure = Schema.decodeUnknownOption(RecorderFailure);
const decodeRead = Schema.decodeUnknownOption(RecordingRead);
const decodeRelease = Schema.decodeUnknownOption(RecordingRelease);
const encodeJob = Schema.encodeSync(RecorderJobSchema);
const encodeCue = Schema.encodeSync(RecorderCue);
const encodeDelivery = Schema.encodeSync(RecordingDelivery);

/** Below this much free disk the sheet says space is low. */
const LOW_SPACE = 2 * 1024 ** 3;
/** Below this much a recording does not start, and the control says space runs low. */
const SPACE_TO_START = 1024 ** 3;
/** Below this much a recording stops, keeping what it holds. */
const SPACE_TO_STOP = 300 * 1024 ** 2;
const SPACE_EVERY = Duration.seconds(15);
const WINDOW_EVERY = Duration.seconds(1);
const PILL = { width: 320, height: 64 } as const;

/** Where System Settings gives macOS's permissions. */
const MAC_SETTINGS = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  keys: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
} as const;

interface Options {
  readonly main: BrowserWindow;
  readonly appOrigin: string;
  readonly preload: string;
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Whether a transparent window shows what is behind it here. */
  readonly transparent: boolean;
  readonly wayland: boolean;
  readonly reader: WindowReader;
  /** Shows the app's window. */
  readonly bringMain: () => void;
  readonly sendCommand: (command: ShellCommand) => void;
  /** The app's folder for recordings. */
  readonly folder: string;
}

interface Live {
  readonly id: RecordingId;
  readonly job: RecorderJob;
  readonly pill: BrowserWindow;
  /** Each screen, its video's size as the control first asked for it. */
  screens: ReadonlyArray<RecordedScreen>;
  phase: "starting" | "recording" | "ending";
  startedAt: number | null;
  pausedAt: number | null;
  pausedTotal: number;
  events: ReturnType<typeof makeEvents> | null;
  /** What runs beside the recording: the input hook, the readers, the disk's watch. */
  readonly beside: Scope.Closeable;
  /** Writes to the recording's folder, one after another. */
  writes: Promise<void>;
  writeFailed: boolean;
  space: "enough" | "low";
}

const systemOf = (platform: NodeJS.Platform): System =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";

const randomId = Effect.gen(function* () {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "rec_";
  for (let at = 0; at < 16; at++) id += alphabet[yield* Random.nextIntBetween(0, 35)];
  return id as RecordingId;
});

/** The screens to record, left to right, each with the system's source for it. */
const screensHere = Effect.fn("recording.screensHere")(function* () {
  const sources = yield* Effect.tryPromise({
    try: () =>
      desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
    catch: () => "unavailable" as const,
  }).pipe(Effect.orElseSucceed(() => []));
  const displays = screen
    .getAllDisplays()
    .toSorted((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const byId = new Map(displays.map((display) => [String(display.id), display]));
  const matched = sources.every((source) => byId.has(source.display_id));
  // Wayland's portal gives the screens the operator shared, with no display
  // to match: one goes with the primary display, several in order.
  const displayOf = (index: number, displayId: string): Display =>
    (matched ? byId.get(displayId) : sources.length === 1 ? undefined : displays[index]) ??
    screen.getPrimaryDisplay();
  return sources
    .map((source, index) => ({ source, display: displayOf(index, source.display_id) }))
    .toSorted(
      (a, b) => a.display.bounds.x - b.display.bounds.x || a.display.bounds.y - b.display.bounds.y,
    )
    .slice(0, 16)
    .map(({ source, display }, index) => ({
      screen: index + 1,
      source: source.id,
      bounds: display.bounds,
      video: videoSize({
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      }),
    }));
});

/** Keeps screen recording on this computer while the scope lasts. */
export const serve = Effect.fn("desktop.recorder")(function* (options: Options) {
  const { main, fromApp } = options;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);
  const runSync = Effect.runSyncWith(context);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const store = yield* makeStore(options.folder);
  /** Finished recordings the page has not released, kept across restarts. */
  const ready = new Map<RecordingId, Ready>();
  for (const one of yield* store.recover().pipe(Effect.orElseSucceed(() => []))) {
    ready.set(one.id, one);
  }
  let live: Live | null = null;
  const platform = process.platform;
  const input: RecordingCheck["input"] = options.wayland ? "screen-and-voice" : "everything";
  const passwords = passwordsHere(platform);

  const now = () => runSync(Clock.currentTimeMillis);
  /** The recording's time: paused time left out. */
  const recordedAt = (at: Live) =>
    at.startedAt === null ? 0 : (at.pausedAt ?? now()) - at.startedAt - at.pausedTotal;

  const fromPill = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    live !== null && !live.pill.isDestroyed() && event.sender === live.pill.webContents;
  const fromMain = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    fromApp(event) && event.sender === main.webContents;

  const deliver = (delivery: RecordingDelivery) => {
    if (!main.isDestroyed())
      main.webContents.send(IPC_CHANNELS.recording, encodeDelivery(delivery));
  };
  const deliverReady = (one: Ready) =>
    deliver({
      _tag: "ready",
      id: one.id,
      target: one.target,
      pairing: one.pairing,
      size: one.size,
      startedAt: DateTime.makeUnsafe(one.startedAt),
      interrupted: one.interrupted,
    });
  const cue = (at: Live, value: RecorderCue) => {
    if (!at.pill.isDestroyed())
      at.pill.webContents.send(IPC_CHANNELS.recorderCue, encodeCue(value));
  };

  /** Writes to the recording's folder after those before; a failure stops the recording. */
  const write = <E>(at: Live, effect: Effect.Effect<void, E>) => {
    at.writes = at.writes.then(() =>
      runPromise(
        effect.pipe(
          Effect.catch((error) =>
            Effect.logError("Writing a screen recording failed", error).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (!at.writeFailed) {
                    at.writeFailed = true;
                    cue(at, { _tag: "stop" });
                  }
                }),
              ),
            ),
          ),
        ),
      ),
    );
  };

  const take = (at: Live, output: Output) => {
    if (output.lines.length > 0) write(at, store.appendLines(at.id, output.lines));
    for (const frame of output.frames) {
      cue(at, { _tag: "frame", screen: frame.screen, name: frame.name });
    }
  };

  const check = Effect.fn("recording.check")(function* () {
    const free = yield* freeSpaceAt(options.folder).pipe(Effect.provide(services));
    const mac = platform === "darwin";
    return {
      input,
      passwords,
      screen: mac
        ? systemPreferences.getMediaAccessStatus("screen") === "granted"
          ? "granted"
          : "needed"
        : "not-needed",
      keys:
        mac && input === "everything"
          ? systemPreferences.isTrustedAccessibilityClient(false)
            ? "granted"
            : "needed"
          : "not-needed",
      space: Option.match(free, {
        onNone: () => "enough",
        onSome: (bytes) => (bytes < LOW_SPACE ? "low" : "enough"),
      }),
      busy: live !== null,
    } satisfies RecordingCheck;
  });

  const showWindowsAgain = () => {
    options.bringMain();
  };

  /** Ends the recording: kept and handed to the page, or thrown away. */
  const end = (
    at: Live,
    how:
      | { readonly _tag: "stop"; readonly interrupted: boolean }
      | { readonly _tag: "discard" }
      | { readonly _tag: "failed"; readonly reason: "screen" | "microphone" | "encoder" },
  ) => {
    if (at.phase === "ending") return;
    const started = at.startedAt !== null;
    at.phase = "ending";
    const t = recordedAt(at);
    runFork(Scope.close(at.beside, Exit.void));
    if (at.events !== null) take(at, at.events.finish(t));
    const target = at.job.target;
    const finish = Effect.gen(function* () {
      yield* Effect.promise(() => at.writes);
      if (how._tag === "discard") {
        yield* store.remove(at.id);
        return { _tag: "discarded", target } satisfies RecordingDelivery;
      }
      if (!started || (how._tag === "failed" && t === 0)) {
        yield* store.remove(at.id);
        return {
          _tag: "failed",
          target,
          reason: how._tag === "failed" ? how.reason : "encoder",
        } satisfies RecordingDelivery;
      }
      return yield* store.finish(at.id, t, how._tag === "stop" && how.interrupted).pipe(
        Effect.map((one) => {
          ready.set(one.id, one);
          return one;
        }),
        Effect.catch((error) =>
          Effect.logError("Finishing a screen recording failed", error).pipe(
            Effect.andThen(store.remove(at.id)),
            Effect.as(null),
          ),
        ),
      );
    });
    void runPromise(finish).then((outcome) => {
      if (live === at) live = null;
      if (!at.pill.isDestroyed()) at.pill.destroy();
      showWindowsAgain();
      if (outcome === null) deliver({ _tag: "failed", target, reason: "storage" });
      else if ("_tag" in outcome) deliver(outcome);
      else deliverReady(outcome);
    });
  };

  /** What runs while the recording does, until `at.beside` closes. */
  const beside = (at: Live) =>
    Effect.gen(function* () {
      const events = at.events;
      if (events === null) return;
      const recording = () => at.phase === "recording" && at.pausedAt === null;
      if (
        input === "everything" &&
        (platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false))
      ) {
        const path = yield* Path.Path;
        yield* listenToInput(hookBinary(app.getAppPath(), path.join), (event) => {
          if (!recording()) return;
          if (event.kind === "press") {
            // A press on the control itself is the operator pausing or stopping.
            const pill = at.pill.isDestroyed() ? null : at.pill.getBounds();
            if (
              pill !== null &&
              event.point.x >= pill.x &&
              event.point.x < pill.x + pill.width &&
              event.point.y >= pill.y &&
              event.point.y < pill.y + pill.height
            ) {
              return;
            }
          }
          take(at, events.push({ ...event, at: recordedAt(at) }));
        }).pipe(
          Effect.catch(() => Effect.logWarning("Keys and clicks cannot be read on this computer")),
        );
        if (passwords === "hidden") {
          yield* watchSecureInput(
            (on) => {
              if (at.phase === "recording")
                take(at, events.push({ kind: "secure", at: recordedAt(at), on }));
            },
            () => {
              if (at.phase === "recording") take(at, events.signalLost());
            },
          );
        }
      }
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (!recording()) return;
          const front = yield* options.reader.front({ withTitle: true });
          if (front === null || !recording()) return;
          take(
            at,
            events.push({
              kind: "window",
              at: recordedAt(at),
              app: front.lookingAt.app,
              title: front.lookingAt.title ?? null,
            }),
          );
        }).pipe(Effect.repeat(Schedule.spaced(WINDOW_EVERY))),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const free = yield* freeSpaceAt(options.folder);
          if (Option.isNone(free) || at.phase !== "recording") return;
          if (free.value < SPACE_TO_STOP) {
            cue(at, { _tag: "stop" });
            return;
          }
          const space = free.value < SPACE_TO_START ? "low" : "enough";
          if (space !== at.space) {
            at.space = space;
            cue(at, { _tag: "space", state: space });
          }
        }).pipe(Effect.repeat(Schedule.spaced(SPACE_EVERY)), Effect.provide(services)),
      );
    }).pipe(Scope.provide(at.beside), Effect.provide(services));

  const start = Effect.fn("recording.start")(function* (request: RecordingStart) {
    if (live !== null) return "busy" satisfies RecordingStartResult;
    const free = yield* freeSpaceAt(options.folder).pipe(Effect.provide(services));
    if (Option.isSome(free) && free.value < SPACE_TO_START)
      return "space" satisfies RecordingStartResult;
    const screens = yield* screensHere();
    if (screens.length === 0) return "failed" satisfies RecordingStartResult;
    const id = yield* randomId;
    const startedAt = yield* DateTime.now;
    const local = DateTime.toParts(DateTime.setZone(startedAt, DateTime.zoneMakeLocal()));
    const begun = yield* store
      .begin(id, {
        target: request.target,
        pairing: request.pairing,
        startedAt: DateTime.formatIso(startedAt),
        local: {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: local.hour,
          minute: local.minute,
          second: local.second,
        },
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
        appVersion: app.getVersion(),
        os: { platform, release: process.getSystemVersion() },
        input,
        passwords,
        screens: screens.map(({ screen: number, bounds, video }) => ({
          screen: number,
          bounds,
          video,
        })),
        voice: request.microphone !== null,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (!begun) return "failed" satisfies RecordingStartResult;

    const near = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const pill = new BrowserWindow({
      ...PILL,
      x: Math.round(near.x + (near.width - PILL.width) / 2),
      y: Math.round(near.y + near.height - PILL.height - 24),
      show: false,
      frame: false,
      transparent: options.transparent,
      backgroundColor: options.transparent ? "#00000000" : "#1f1f1f",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // It never takes the keys from the app the operator is showing.
      focusable: false,
      title: "J3 Bots",
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        // Its encoders keep their pace while it is out of sight.
        backgroundThrottling: false,
      },
    });
    pill.setAlwaysOnTop(true, "screen-saver");
    pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Left out of the capture where the system can (macOS, Windows).
    pill.setContentProtection(true);
    const at: Live = {
      id,
      job: {
        target: request.target,
        pairing: request.pairing,
        microphone: request.microphone,
        screens: screens.map(({ screen: number, source, video }) => ({
          screen: number,
          source,
          width: video.width,
          height: video.height,
        })),
      },
      pill,
      screens,
      phase: "starting",
      startedAt: null,
      pausedAt: null,
      pausedTotal: 0,
      events: null,
      beside: yield* Scope.make(),
      writes: Promise.resolve(),
      writeFailed: false,
      space: "enough",
    };
    live = at;
    pill.webContents.on("render-process-gone", () => end(at, { _tag: "stop", interrupted: true }));
    pill.on("closed", () => end(at, { _tag: "stop", interrupted: true }));
    pill.once("ready-to-show", () => pill.showInactive());
    // The app gets out of the way while the operator shows their screen.
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== pill && window.isVisible()) window.hide();
    }
    void pill.loadURL(`${options.appOrigin}${RECORDER_PATH}`);
    return "started" satisfies RecordingStartResult;
  });

  const started = (at: Live, report: RecorderStarted) => {
    if (at.phase !== "starting") return;
    at.screens = at.screens.flatMap((one) => {
      const actual = report.screens.find((reported) => reported.screen === one.screen);
      return actual === undefined
        ? []
        : [{ ...one, video: { width: actual.width, height: actual.height } }];
    });
    at.startedAt = now();
    at.phase = "recording";
    at.events = makeEvents({
      screens: at.screens,
      system: systemOf(platform),
      secureSignal: passwords === "hidden" && input === "everything",
    });
    write(at, store.appendLines(at.id, [{ t: 0, type: "start" } satisfies EventLine]));
    runFork(beside(at));
  };

  const control = (at: Live, action: RecorderControl["action"]) => {
    switch (action) {
      case "pause":
        if (at.phase !== "recording" || at.pausedAt !== null) return;
        if (at.events !== null) take(at, at.events.push({ kind: "pause", at: recordedAt(at) }));
        at.pausedAt = now();
        return;
      case "resume":
        if (at.phase !== "recording" || at.pausedAt === null) return;
        at.pausedTotal += now() - at.pausedAt;
        at.pausedAt = null;
        if (at.events !== null) take(at, at.events.push({ kind: "resume", at: recordedAt(at) }));
        return;
      case "stop":
        end(at, { _tag: "stop", interrupted: false });
        return;
      case "discard":
        end(at, { _tag: "discard" });
        return;
    }
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.handle(IPC_CHANNELS.recordingCheck, (event) =>
        fromMain(event) ? runPromise(check()) : null,
      );
      ipcMain.handle(IPC_CHANNELS.recordingAccess, (event, request: unknown) => {
        const decoded = decodeAccess(request);
        if (!fromMain(event) || Option.isNone(decoded)) return null;
        if (platform === "darwin") {
          if (decoded.value.access === "keys") {
            // Lists the app under Accessibility, the first time, so the operator finds it there.
            systemPreferences.isTrustedAccessibilityClient(true);
          } else {
            // Asking for the screens once lists the app under Screen Recording.
            void desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: 0, height: 0 },
            });
          }
          void shell.openExternal(MAC_SETTINGS[decoded.value.access]);
        }
        return runPromise(check());
      });
      ipcMain.handle(IPC_CHANNELS.startRecording, (event, request: unknown) => {
        const decoded = decodeStart(request);
        if (!fromMain(event) || Option.isNone(decoded)) return "failed";
        return runPromise(start(decoded.value).pipe(Effect.orElseSucceed(() => "failed" as const)));
      });
      ipcMain.on(IPC_CHANNELS.openRecorder, (event, request: unknown) => {
        const decoded = decodeOpen(request);
        if (!fromApp(event) || Option.isNone(decoded)) return;
        options.bringMain();
        options.sendCommand({ _tag: "record", ...decoded.value });
      });
      ipcMain.on(IPC_CHANNELS.recordingsWanted, (event) => {
        if (!fromMain(event)) return;
        for (const one of ready.values()) deliverReady(one);
      });
      ipcMain.handle(IPC_CHANNELS.readRecording, (event, request: unknown) => {
        const decoded = decodeRead(request);
        if (!fromMain(event) || Option.isNone(decoded)) return null;
        const { id, start: from, end: to } = decoded.value;
        return runPromise(
          store.read(id, from, to).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          ),
        );
      });
      ipcMain.on(IPC_CHANNELS.releaseRecording, (event, request: unknown) => {
        const decoded = decodeRelease(request);
        if (!fromMain(event) || Option.isNone(decoded) || !ready.has(decoded.value.id)) return;
        ready.delete(decoded.value.id);
        runFork(store.remove(decoded.value.id));
      });
      ipcMain.handle(IPC_CHANNELS.recorderJob, (event) =>
        live !== null && fromPill(event) ? encodeJob(live.job) : null,
      );
      ipcMain.on(IPC_CHANNELS.recorderStarted, (event, report: unknown) => {
        const decoded = decodeStarted(report);
        if (live !== null && fromPill(event) && Option.isSome(decoded))
          started(live, decoded.value);
      });
      ipcMain.on(IPC_CHANNELS.recorderChunk, (event, chunk: unknown) => {
        const decoded = decodeChunk(chunk);
        if (live === null || !fromPill(event) || Option.isNone(decoded)) return;
        const at = live;
        const { stream, bytes } = decoded.value;
        if (stream._tag === "screen" && !at.job.screens.some((one) => one.screen === stream.screen))
          return;
        write(
          at,
          store.append(at.id, stream._tag === "voice" ? "voice" : { screen: stream.screen }, bytes),
        );
      });
      ipcMain.on(IPC_CHANNELS.recorderFrame, (event, frame: unknown) => {
        const decoded = decodeFrame(frame);
        if (live === null || !fromPill(event) || Option.isNone(decoded)) return;
        write(live, store.frame(live.id, decoded.value.name, decoded.value.bytes));
      });
      ipcMain.on(IPC_CHANNELS.recorderControl, (event, request: unknown) => {
        const decoded = decodeControl(request);
        if (live !== null && fromPill(event) && Option.isSome(decoded))
          control(live, decoded.value.action);
      });
      ipcMain.on(IPC_CHANNELS.recorderFailed, (event, failure: unknown) => {
        const decoded = decodeFailure(failure);
        if (live === null || !fromPill(event) || Option.isNone(decoded)) return;
        end(live, { _tag: "failed", reason: decoded.value.reason });
      });
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeHandler(IPC_CHANNELS.recordingCheck);
        ipcMain.removeHandler(IPC_CHANNELS.recordingAccess);
        ipcMain.removeHandler(IPC_CHANNELS.startRecording);
        ipcMain.removeAllListeners(IPC_CHANNELS.openRecorder);
        ipcMain.removeAllListeners(IPC_CHANNELS.recordingsWanted);
        ipcMain.removeHandler(IPC_CHANNELS.readRecording);
        ipcMain.removeAllListeners(IPC_CHANNELS.releaseRecording);
        ipcMain.removeHandler(IPC_CHANNELS.recorderJob);
        ipcMain.removeAllListeners(IPC_CHANNELS.recorderStarted);
        ipcMain.removeAllListeners(IPC_CHANNELS.recorderChunk);
        ipcMain.removeAllListeners(IPC_CHANNELS.recorderFrame);
        ipcMain.removeAllListeners(IPC_CHANNELS.recorderControl);
        ipcMain.removeAllListeners(IPC_CHANNELS.recorderFailed);
      }),
  );

  return {
    /**
     * Whether a page may have the microphone or the screens: the app's own
     * page may have a microphone (the sheet's level meter); only the
     * recorder's control may have the screens, while it records.
     */
    allowsMedia: (contents: WebContents, mediaTypes: ReadonlyArray<string>) =>
      mediaTypes.every((type) => type === "audio") ||
      (live !== null && !live.pill.isDestroyed() && contents === live.pill.webContents),
  };
});
