// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  DeviceId,
  EntryTarget,
  Language,
  PairingCode,
  PairingLinkTarget,
  UpdateChannel,
} from "@j3-bots/contracts";
import {
  type Appearance,
  AppLink,
  BRIDGE_KEY,
  ConnectResult,
  type DesktopMode,
  type Destination,
  ForgetResult,
  HostedBridge,
  LocalDeviceResult,
  LocalExportResult,
  LocalPairingLink,
  LocalServerState,
  type LookingAtChange,
  LookingAtSettings,
  ModeChange,
  type MovedAway,
  UseThisComputerResult,
  NetworkState,
  NotificationClick,
  type NotificationRequest,
  PhoneAccess,
  PhoneAccessChange,
  QuickAccessCue,
  QuickAccessPicture,
  RecorderCue,
  type RecorderChunk,
  type RecorderControl,
  type RecorderFailure,
  type RecorderFrame,
  RecorderJob,
  type RecorderStarted,
  RecordingCheck,
  RecordingDelivery,
  type RecordingId,
  RecordingStart,
  RecordingStartResult,
  ShellCommand,
  ShortcutChange,
  ShortcutStatus,
  StartWithSystemChange,
  SignInRelayStart,
  SignInReturn,
  type TrayReport,
  OpenResult,
  SealResult,
  Theme,
  type TokenProtection,
  UpdateStatus,
} from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The system the desktop app runs on, from the user agent its window reports. */
export const systemOf = (userAgent: string): "windows" | "mac" | "linux" =>
  /Windows/.test(userAgent) ? "windows" : /Macintosh|Mac OS X/.test(userAgent) ? "mac" : "linux";

/** A token as the desktop app sealed it, and how it is kept. */
interface SealedToken {
  readonly sealed: string;
  readonly protection: TokenProtection;
}

/** What the desktop app offers the page it hosts. */
export interface Desktop {
  /** The server the operator named, or `null` until they have. */
  readonly server: URL | null;
  /**
   * The code of the pairing link the operator followed to `server`, for the
   * pairing screen to start with, or `null`.
   */
  readonly pairingCode: PairingCode | null;
  /** Where the bots live, or `null` until the operator has chosen. */
  readonly mode: DesktopMode | null;
  /**
   * Checks the address the operator typed and keeps it if a J3 Bots server
   * answers there. `pairing` is the pairing link that filled the address in:
   * once the server it names is kept, the page that loads next starts the
   * pairing screen with its code (`pairingCode`). `null` when the app gave no
   * answer the page understands.
   */
  readonly connect: (
    address: string,
    pairing: PairingLinkTarget | null,
  ) => Promise<ConnectResult | null>;
  /**
   * Forgets the server, with everything this page kept for it, and opens the
   * app's first page. Resolves `false` when the server is still kept.
   */
  readonly forgetServer: () => Promise<boolean>;
  /** Encrypts a device token for this profile; `null` when it could not. */
  readonly sealToken: (token: string) => Promise<SealedToken | null>;
  /**
   * The token `sealed` holds, `failed` when it is not one this profile
   * sealed, or `unavailable` when the app could not open it now, nor say.
   */
  readonly openToken: (sealed: string) => Promise<OpenResult>;
  /** Whether the system has a network; `null` when the app did not say. */
  readonly online: () => Promise<boolean | null>;
  /** Calls `listener` each time the system wakes from sleep; answers a function that stops it. */
  readonly onResumed: (listener: (online: boolean) => void) => () => void;
  /** Restarts the app, which keeps this page's storage. */
  readonly relaunch: () => void;
  /** Where updating the app stands; `null` when the app gave no answer the page understands. */
  readonly updateStatus: () => Promise<UpdateStatus | null>;
  /** Calls `listener` each time the update's status changes; answers a function that stops it. */
  readonly onUpdate: (listener: (status: UpdateStatus) => void) => () => void;
  /** Checks for an update now, unless one is on its way or ready. */
  readonly checkForUpdates: () => void;
  /**
   * Restarts into the downloaded update, as soon as no save is under way.
   * Where updates install by themselves it also installs as the app quits.
   */
  readonly restartToUpdate: () => void;
  /** Calls off a restart into the update that waits for a save; the update stays ready. */
  readonly cancelRestartToUpdate: () => void;
  /**
   * Chooses the releases the app follows; answers the status after it, which
   * keeps the channel it had while a version is on its way or installing.
   */
  readonly setUpdateChannel: (channel: UpdateChannel) => Promise<UpdateStatus | null>;
  /** Turns installing a verified version by itself on or off; answers the status after it. */
  readonly setAutomaticUpdates: (on: boolean) => Promise<UpdateStatus | null>;
  /** Tells the app whether a save is under way, which a restart waits for. */
  readonly reportSaving: (saving: boolean) => void;
  /** Shows a notification with the system's own notifications. */
  readonly notify: (request: NotificationRequest) => void;
  /** Closes the notifications `pairing`, which ended, received. */
  readonly closeNotifications: (pairing: DeviceId) => void;
  /** Calls `listener` with each notification the operator clicks; answers a function that stops it. */
  readonly onNotificationClick: (listener: (click: NotificationClick) => void) => () => void;
  /**
   * Calls `listener` with each link to the app the operator follows, starting
   * with one that arrived before; answers a function that stops it.
   */
  readonly onAppLink: (listener: (link: AppLink) => void) => () => void;
  /** Tells the app the language the page shows, which its menus follow. */
  readonly reportLanguage: (language: Language) => void;
  /** Tells the app the appearance the operator chose, which its window takes from the next launch's first paint. */
  readonly reportAppearance: (appearance: Appearance) => void;
  /**
   * The theme the system draws its notifications in, apart from the app's own,
   * which `prefers-color-scheme` answers with here; `null` when the app gave
   * no answer the page understands.
   */
  readonly systemTheme: () => Promise<Theme | null>;
  /** Tells the app what its tray lists. */
  readonly reportTray: (report: TrayReport) => void;
  /** Calls `listener` with each command from the app's menus, tray or shortcut; answers a function that stops it. */
  readonly onCommand: (listener: (command: ShellCommand) => void) => () => void;
  /** The global shortcut and whether it works; `null` when the app gave no answer the page understands. */
  readonly shortcutStatus: () => Promise<ShortcutStatus | null>;
  /** Changes the global shortcut; `null` when the app gave no answer the page understands. */
  readonly setShortcut: (accelerator: string) => Promise<ShortcutChange | null>;
  /** What quick access reads of the window in front; `null` when the app gave no answer the page understands. */
  readonly lookingAt: () => Promise<LookingAtSettings | null>;
  /** Changes what quick access reads of the window in front, answering what it reads now. */
  readonly setLookingAt: (change: LookingAtChange) => Promise<LookingAtSettings | null>;
  /** Asks the system to let the app read windows (macOS: Screen Recording), answering what it reads now. */
  readonly askScreenAccess: () => Promise<LookingAtSettings | null>;
  /** Whether this computer can run the bots itself. */
  readonly localAvailable: boolean;
  /** In local mode, the server this computer runs as the page loaded; `null` otherwise. */
  readonly localServer: LocalServerState | null;
  /** Whether the app starts, in the tray, as the operator signs in to the system. */
  readonly startWithSystem: boolean;
  /**
   * Runs the bots on this computer, forgetting any server elsewhere; once it
   * has, the app loads the page again. `null` when the app gave no answer the
   * page understands.
   */
  readonly chooseThisComputer: () => Promise<UseThisComputerResult | null>;
  /**
   * Stops the bots on this computer, their data kept, for a server elsewhere;
   * once it has, the app loads the page again on the server address screen.
   */
  readonly connectToServerInstead: () => Promise<ModeChange | null>;
  /**
   * The export the bots on this computer moved away with, while their data
   * is still here and their server stays stopped; `null` while they did not.
   */
  readonly moved: MovedAway | null;
  /**
   * Moves the bots on this computer to another server: asks where to write
   * the export, its secrets sealed under `passphrase`, stops their server and
   * writes it; once it has, the app loads the page again. `null` when the
   * app gave no answer the page understands.
   */
  readonly moveAway: (passphrase: Redacted.Redacted<string>) => Promise<LocalExportResult | null>;
  /** Runs the bots that moved away here again; once it has, the app loads the page again. */
  readonly runHereAgain: () => Promise<ModeChange | null>;
  /**
   * Deletes the data the bots that moved away left on this computer. In local
   * mode the app then loads its first page, which asks where the bots live.
   */
  readonly deleteLocalData: () => Promise<ModeChange | null>;
  /** Starts the server on this computer again now, after it failed or while it waits to. */
  readonly retryLocalServer: () => void;
  /** Tries the update the server on this computer was rolled back from again. */
  readonly retryServerUpdate: () => void;
  /**
   * Calls `listener` with the state of the server on this computer now, then
   * each time it changes; answers a function that stops it.
   */
  readonly onLocalServer: (listener: (state: LocalServerState | null) => void) => () => void;
  /**
   * Signs this computer in to the server it runs, once that is ready. `again`:
   * the operator asked to, after this computer was signed out. `null` when
   * the app gave no answer the page understands.
   */
  readonly localDevice: (again: boolean) => Promise<LocalDeviceResult | null>;
  /** Changes whether the app starts with the system; `null` when the app gave no answer the page understands. */
  readonly setStartWithSystem: (on: boolean) => Promise<StartWithSystemChange | null>;
  /** Whether phones on this network reach the server on this computer, as the page loaded. */
  readonly phoneAccess: PhoneAccess;
  /**
   * Calls `listener` with phone access now, its addresses read again, then
   * each time it changes; answers a function that stops it.
   */
  readonly onPhoneAccess: (listener: (access: PhoneAccess) => void) => () => void;
  /**
   * Turns phone access on or off; `stopWork`: the operator agreed that the
   * server's restart stops the work bots have running. `null` when the app
   * gave no answer the page understands.
   */
  readonly setPhoneAccess: (on: boolean, stopWork: boolean) => Promise<PhoneAccessChange | null>;
  /**
   * A pairing code for a phone; `unlock` lifts the lock wrong codes set
   * first. `null` when the app gave no answer the page understands.
   */
  readonly localPairingLink: (unlock: boolean) => Promise<LocalPairingLink | null>;
  /**
   * Listens on this computer's loopback for the browser's return from a
   * connector's sign-in, in place of any listener before: the port it
   * listens on, or `null` when the app could not listen.
   */
  readonly catchSignIn: (language: Language) => Promise<number | null>;
  /**
   * Tells the listener on `port` the state of the sign-in it waits for, which
   * the only return it takes carries: whether it still listens and took it.
   */
  readonly expectSignIn: (port: number, state: Redacted.Redacted<string>) => Promise<boolean>;
  /** Stops the listener on `port`, if it still listens. */
  readonly stopCatchingSignIn: (port: number) => void;
  /**
   * Calls `listener` with the address the browser came back to from each
   * sign-in the app caught; answers a function that stops it.
   */
  readonly onSignInReturn: (listener: (url: string) => void) => () => void;
  /**
   * Puts a secret's value on the clipboard, which the app takes off after a
   * while if the clipboard still holds it: whether it got there.
   */
  readonly copySecret: (value: Redacted.Redacted<string>) => Promise<boolean>;
  /** What the quick access window's page asks of the app. Any other page is not answered. */
  readonly quickAccess: DesktopQuickAccess;
  /** Recording the screens for a bot (decision 0098), as the main window's page asks. */
  readonly recording: DesktopRecording;
  /** What the recorder's floating control's page asks of the app. Any other page is not answered. */
  readonly recorder: DesktopRecorder;
}

/** Recording the screens, as the main window's page speaks to the app. */
interface DesktopRecording {
  /** What the sheet shows before a recording starts; `null` when the app gave no answer the page understands. */
  readonly check: () => Promise<RecordingCheck | null>;
  /** Opens where the operator gives a permission the check says is needed, answering the check after it. */
  readonly askAccess: (access: "screen" | "keys") => Promise<RecordingCheck | null>;
  /** Starts recording; the app hides its windows and shows its floating control. */
  readonly start: (request: RecordingStart) => Promise<RecordingStartResult>;
  /** From quick access: shows the main window with the sheet open on `target`. */
  readonly openInMain: (target: EntryTarget, pairing: DeviceId) => void;
  /**
   * Calls `listener` with each recording that ends, starting with those the
   * app kept from before; answers a function that stops it.
   */
  readonly onRecording: (listener: (delivery: RecordingDelivery) => void) => () => void;
  /** Bytes `[start, end)` of a ready recording's zip; `null` once it is gone or the app could not read it. */
  readonly read: (id: RecordingId, start: number, end: number) => Promise<Uint8Array | null>;
  /** The page no longer needs the recording: the app deletes it. */
  readonly release: (id: RecordingId) => void;
}

/** The app, as the page of the recorder's floating control speaks to it. */
interface DesktopRecorder {
  /** What to record; `null` when no recording waits for this page. */
  readonly job: () => Promise<RecorderJob | null>;
  readonly started: (report: RecorderStarted) => void;
  readonly chunk: (chunk: RecorderChunk) => void;
  readonly frame: (frame: RecorderFrame) => void;
  readonly control: (action: RecorderControl["action"]) => void;
  readonly failed: (reason: RecorderFailure["reason"]) => void;
  /** Calls `listener` with each cue the app sends; answers a function that stops it. */
  readonly onCue: (listener: (cue: RecorderCue) => void) => () => void;
}

/** The app, as the page of its quick access window speaks to it. */
interface DesktopQuickAccess {
  /**
   * Tells the app whether quick access has what it shows: until it has, the
   * global shortcut shows the main window instead.
   */
  readonly report: (available: boolean) => void;
  /**
   * Calls `listener` each time the app shows the window (`open`), asks the
   * page to go out before it hides it (`leave`), or read the window that
   * was in front as it opened (`seen`); answers a function that stops it.
   */
  readonly onCue: (listener: (cue: QuickAccessCue) => void) => () => void;
  /**
   * Hides the window, once the page has gone out of the showing `opening`
   * numbers (the latest `open` cue's). The app leaves up a window it has
   * shown again since.
   */
  readonly hide: (opening: number) => void;
  /** Shows the main window at `target`, under `pairing`, and hides quick access. */
  readonly openInMain: (target: Destination, pairing: DeviceId) => void;
  /**
   * A picture of the window that was in front as showing `opening` opened;
   * `failed` when the app gave no answer the page understands.
   */
  readonly picture: (opening: number) => Promise<QuickAccessPicture>;
}

const decodeBridge = Schema.decodeUnknownOption(HostedBridge);
const decodeResult = Schema.decodeUnknownOption(ConnectResult);
const decodeForget = Schema.decodeUnknownOption(ForgetResult);
const decodeSeal = Schema.decodeUnknownOption(SealResult);
const decodeOpen = Schema.decodeUnknownOption(OpenResult);
const decodeNetwork = Schema.decodeUnknownOption(NetworkState);
const decodeStatus = Schema.decodeUnknownOption(UpdateStatus);
const decodeClick = Schema.decodeUnknownOption(NotificationClick);
const decodeLink = Schema.decodeUnknownOption(AppLink);
const decodeCommand = Schema.decodeUnknownOption(ShellCommand);
const decodeCue = Schema.decodeUnknownOption(QuickAccessCue);
const decodeShortcut = Schema.decodeUnknownOption(ShortcutStatus);
const decodeShortcutChange = Schema.decodeUnknownOption(ShortcutChange);
const decodeLookingAt = Schema.decodeUnknownOption(LookingAtSettings);
const decodePicture = Schema.decodeUnknownOption(QuickAccessPicture);
const decodeTheme = Schema.decodeUnknownOption(Theme);
const decodeModeChange = Schema.decodeUnknownOption(ModeChange);
const decodeUseThisComputer = Schema.decodeUnknownOption(UseThisComputerResult);
const decodeExportResult = Schema.decodeUnknownOption(LocalExportResult);
const decodeLocalServer = Schema.decodeUnknownOption(Schema.NullOr(LocalServerState));
const decodeLocalDevice = Schema.decodeUnknownOption(LocalDeviceResult);
const decodeStartWithSystem = Schema.decodeUnknownOption(StartWithSystemChange);
const decodePhoneAccess = Schema.decodeUnknownOption(PhoneAccess);
const decodePhoneAccessChange = Schema.decodeUnknownOption(PhoneAccessChange);
const decodePairingLink = Schema.decodeUnknownOption(LocalPairingLink);
const decodeRelayStart = Schema.decodeUnknownOption(SignInRelayStart);
const decodeExpected = Schema.decodeUnknownOption(Schema.Boolean);
const decodeSignInReturn = Schema.decodeUnknownOption(SignInReturn);
const decodeRecordingCheck = Schema.decodeUnknownOption(RecordingCheck);
const decodeStartResult = Schema.decodeUnknownOption(RecordingStartResult);
const decodeDelivery = Schema.decodeUnknownOption(RecordingDelivery);
const decodeRecordingBytes = Schema.decodeUnknownOption(Schema.Uint8Array);
const decodeJob = Schema.decodeUnknownOption(RecorderJob);
const decodeRecorderCue = Schema.decodeUnknownOption(RecorderCue);
const encodeStart = Schema.encodeSync(RecordingStart);
const hosted: unknown = Reflect.get(window, BRIDGE_KEY);

/** What `call` answers, decoded; `null` when it throws, rejects or answers something else. */
const ask = <A>(call: () => unknown, decode: (answer: unknown) => Option.Option<A>) =>
  Promise.resolve()
    .then(call)
    .then(
      (answer) => Option.getOrNull(decode(answer)),
      () => null,
    );

/**
 * The desktop app's bridge, when this page runs in it: its preload script
 * set one, and it decodes. In a browser, `null`.
 */
export const desktop: Desktop | null = Option.match(decodeBridge(hosted), {
  onNone: () => null,
  onSome: (bridge) => ({
    server: bridge.state.server === null ? null : new URL(bridge.state.server),
    pairingCode: bridge.state.pairingCode,
    mode: bridge.state.mode,
    connect: (address, pairing) =>
      ask(
        () => bridge.connect(pairing === null ? { address } : { address, pairing }),
        decodeResult,
      ),
    forgetServer: () =>
      ask(() => bridge.forgetServer(), decodeForget).then((answer) => answer === "forgotten"),
    sealToken: (token) =>
      ask(() => bridge.sealToken(token), decodeSeal).then((answer) =>
        answer?._tag === "sealed" ? { sealed: answer.sealed, protection: answer.protection } : null,
      ),
    openToken: (sealed) =>
      ask(() => bridge.openToken(sealed), decodeOpen).then(
        (answer): OpenResult => answer ?? { _tag: "unavailable" },
      ),
    online: () =>
      ask(() => bridge.networkStatus(), decodeNetwork).then((answer) => answer?.online ?? null),
    onResumed: (listener) => {
      const stop: unknown = bridge.onResumed((state: unknown) =>
        Option.map(decodeNetwork(state), ({ online }) => listener(online)),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    relaunch: () => {
      bridge.relaunch();
    },
    updateStatus: () => ask(() => bridge.updateStatus(), decodeStatus),
    onUpdate: (listener) => {
      const stop: unknown = bridge.onUpdate((status: unknown) =>
        Option.map(decodeStatus(status), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    notify: (request) => {
      bridge.notify(request);
    },
    closeNotifications: (pairing) => {
      bridge.closeNotifications({ pairing });
    },
    onNotificationClick: (listener) => {
      const stop: unknown = bridge.onNotificationClick((click: unknown) =>
        Option.map(decodeClick(click), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    onAppLink: (listener) => {
      const stop: unknown = bridge.onAppLink((link: unknown) =>
        Option.map(decodeLink(link), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    reportLanguage: (language) => {
      bridge.reportLanguage({ language });
    },
    reportAppearance: (appearance) => {
      bridge.reportAppearance({ appearance });
    },
    systemTheme: () => ask(() => bridge.systemTheme(), decodeTheme),
    reportTray: (report) => {
      bridge.reportTray(report);
    },
    onCommand: (listener) => {
      const stop: unknown = bridge.onCommand((command: unknown) =>
        Option.map(decodeCommand(command), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    shortcutStatus: () => ask(() => bridge.shortcutStatus(), decodeShortcut),
    setShortcut: (accelerator) => ask(() => bridge.setShortcut(accelerator), decodeShortcutChange),
    lookingAt: () => ask(() => bridge.lookingAt(), decodeLookingAt),
    setLookingAt: (change) => ask(() => bridge.setLookingAt(change), decodeLookingAt),
    askScreenAccess: () => ask(() => bridge.askScreenAccess(), decodeLookingAt),
    checkForUpdates: () => {
      bridge.checkForUpdates();
    },
    restartToUpdate: () => {
      bridge.restartToUpdate();
    },
    cancelRestartToUpdate: () => {
      bridge.cancelRestartToUpdate();
    },
    setUpdateChannel: (channel) => ask(() => bridge.setUpdateChannel(channel), decodeStatus),
    setAutomaticUpdates: (on) => ask(() => bridge.setAutomaticUpdates(on), decodeStatus),
    reportSaving: (saving) => {
      bridge.reportSaving(saving);
    },
    localAvailable: bridge.state.localAvailable,
    localServer: bridge.state.localServer,
    startWithSystem: bridge.state.startWithSystem,
    chooseThisComputer: () => ask(() => bridge.useThisComputer(), decodeUseThisComputer),
    connectToServerInstead: () => ask(() => bridge.connectToServerInstead(), decodeModeChange),
    moved: bridge.state.moved ?? null,
    moveAway: (passphrase) =>
      ask(() => bridge.exportLocal({ passphrase: Redacted.value(passphrase) }), decodeExportResult),
    runHereAgain: () => ask(() => bridge.runHereAgain(), decodeModeChange),
    deleteLocalData: () => ask(() => bridge.deleteLocalData(), decodeModeChange),
    retryLocalServer: () => {
      bridge.retryLocalServer();
    },
    retryServerUpdate: () => {
      bridge.retryServerUpdate();
    },
    onLocalServer: (listener) => {
      const stop: unknown = bridge.onLocalServer((state: unknown) =>
        Option.map(decodeLocalServer(state), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    localDevice: (again) => ask(() => bridge.localDevice({ again }), decodeLocalDevice),
    setStartWithSystem: (on) => ask(() => bridge.setStartWithSystem(on), decodeStartWithSystem),
    phoneAccess: bridge.state.phoneAccess,
    onPhoneAccess: (listener) => {
      const stop: unknown = bridge.onPhoneAccess((access: unknown) =>
        Option.map(decodePhoneAccess(access), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    catchSignIn: (language) =>
      ask(() => bridge.catchSignIn({ language }), decodeRelayStart).then((answer) =>
        answer?._tag === "listening" ? answer.port : null,
      ),
    expectSignIn: (port, state) =>
      ask(() => bridge.expectSignIn({ port, state: Redacted.value(state) }), decodeExpected).then(
        (taken) => taken === true,
      ),
    stopCatchingSignIn: (port) => {
      bridge.stopCatchingSignIn({ port });
    },
    onSignInReturn: (listener) => {
      const stop: unknown = bridge.onSignInReturn((signInReturn: unknown) =>
        Option.map(decodeSignInReturn(signInReturn), ({ url }) => listener(url)),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    copySecret: (value) =>
      ask(() => bridge.copySecret({ text: Redacted.value(value) }), decodeExpected).then(
        (copied) => copied === true,
      ),
    setPhoneAccess: (on, stopWork) =>
      ask(() => bridge.setPhoneAccess({ on, stopWork }), decodePhoneAccessChange),
    localPairingLink: (unlock) => ask(() => bridge.localPairingLink({ unlock }), decodePairingLink),
    quickAccess: {
      report: (available) => {
        bridge.reportQuickAccess({ available });
      },
      onCue: (listener) => {
        const stop: unknown = bridge.onQuickAccessCue((cue: unknown) =>
          Option.map(decodeCue(cue), listener),
        );
        return () => {
          if (typeof stop === "function") stop();
        };
      },
      hide: (opening) => {
        bridge.hideQuickAccess({ opening });
      },
      openInMain: (target, pairing) => {
        bridge.openFromQuickAccess({ target, pairing });
      },
      picture: (opening) =>
        ask(() => bridge.quickAccessPicture({ opening }), decodePicture).then(
          (picture): QuickAccessPicture => picture ?? { _tag: "failed" },
        ),
    },
    recording: {
      check: () => ask(() => bridge.recordingCheck(), decodeRecordingCheck),
      askAccess: (access) => ask(() => bridge.recordingAccess({ access }), decodeRecordingCheck),
      start: (request) =>
        ask(() => bridge.startRecording(encodeStart(request)), decodeStartResult).then(
          (result): RecordingStartResult => result ?? "failed",
        ),
      openInMain: (target, pairing) => {
        bridge.openRecorder({ target, pairing });
      },
      onRecording: (listener) => {
        const stop: unknown = bridge.onRecording((delivery: unknown) =>
          Option.map(decodeDelivery(delivery), listener),
        );
        return () => {
          if (typeof stop === "function") stop();
        };
      },
      read: (id, start, end) =>
        ask(() => bridge.readRecording({ id, start, end }), decodeRecordingBytes),
      release: (id) => {
        bridge.releaseRecording({ id });
      },
    },
    recorder: {
      job: () => ask(() => bridge.recorderJob(), decodeJob),
      started: (report) => {
        bridge.recorderStarted(report);
      },
      chunk: (chunk) => {
        bridge.recorderChunk(chunk);
      },
      frame: (frame) => {
        bridge.recorderFrame(frame);
      },
      control: (action) => {
        bridge.recorderControl({ action });
      },
      failed: (reason) => {
        bridge.recorderFailed({ reason });
      },
      onCue: (listener) => {
        const stop: unknown = bridge.onRecorderCue((cue: unknown) =>
          Option.map(decodeRecorderCue(cue), listener),
        );
        return () => {
          if (typeof stop === "function") stop();
        };
      },
    },
  }),
});
