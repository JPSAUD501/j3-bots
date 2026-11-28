// SPDX-License-Identifier: AGPL-3.0-or-later

// The bridge's names and its shape as the preload script builds it, with no
// dependency, so the sandboxed preload script carries nothing else.

/** The property of `window` the preload script sets. Absent in a browser. */
export const BRIDGE_KEY = "j3Desktop";

/** The IPC channels between the preload script and the main process. */
export const IPC_CHANNELS = {
  /** Synchronous, once, as the preload script runs: answers `DesktopState`. */
  state: "j3bots:state",
  /** `ConnectRequest`, answered with `ConnectResult`. */
  connect: "j3bots:connect",
  /** Forgets the server and loads the page again, on the server address screen. Answers `ForgetResult`. */
  forgetServer: "j3bots:forget-server",
  /** `SealRequest`, answered with `SealResult`. */
  sealToken: "j3bots:seal-token",
  /** `OpenRequest`, answered with `OpenResult`. */
  openToken: "j3bots:open-token",
  /** Answers `NetworkState`. */
  network: "j3bots:network",
  /** From the main process, as the system wakes from sleep: `NetworkState`. */
  resumed: "j3bots:resumed",
  /** Restarts the app, its storage kept. Not answered: the page goes with the app. */
  relaunch: "j3bots:relaunch",
  /** Answers `UpdateStatus`. */
  update: "j3bots:update",
  /** From the main process, each time the update's status changes: `UpdateStatus`. */
  updateChanged: "j3bots:update-changed",
  /** Checks for an update now, unless one is being checked, downloaded or ready. Not answered. */
  checkForUpdates: "j3bots:check-for-updates",
  /** Restarts into the downloaded update once no save is under way. Not answered. */
  restartToUpdate: "j3bots:restart-to-update",
  /** Calls off a restart into the update that waits for a save, and offers it again. Not answered. */
  cancelRestartToUpdate: "j3bots:cancel-restart-to-update",
  /**
   * `UpdateChannelRequest`: the releases the app follows from now on, unless a
   * version is on its way or installing. Answers the `UpdateStatus` after it.
   */
  setUpdateChannel: "j3bots:set-update-channel",
  /**
   * `AutomaticUpdatesRequest`: whether a verified version installs by itself,
   * at launch or as the app quits. Answers the `UpdateStatus` after it.
   */
  setAutomaticUpdates: "j3bots:set-automatic-updates",
  /** `SavingReport`: whether a save is under way in the page. Not answered. */
  saving: "j3bots:saving",
  /** `NotificationRequest`: shows a notification on the system's screen. Not answered. */
  notify: "j3bots:notify",
  /** `CloseNotificationsRequest`: closes those a pairing that ended received. Not answered. */
  closeNotifications: "j3bots:close-notifications",
  /** From the main process, as the operator clicks a notification: `NotificationClick`. */
  notificationClicked: "j3bots:notification-clicked",
  /** The page listens for links now: the main process sends what waited. Not answered. */
  appLinksWanted: "j3bots:app-links-wanted",
  /** From the main process, as the operator follows a link to the app: `AppLink`. */
  appLinkOpened: "j3bots:app-link-opened",
  /** `LanguageReport`: the language the page shows, for the app's menus. Not answered. */
  language: "j3bots:language",
  /** `AppearanceReport`: the appearance the operator chose, for the window. Not answered. */
  appearance: "j3bots:appearance",
  /** Answers `Theme`: the one the system draws its notifications and tray in. */
  systemTheme: "j3bots:system-theme",
  /** `TrayReport`: what the tray lists, each time it changes. Not answered. */
  tray: "j3bots:tray",
  /** From the main process, from its menus or its tray: `ShellCommand`. */
  command: "j3bots:command",
  /**
   * `QuickAccessReport`, from the quick access window's page only: whether it
   * has a primary bot to show. Not answered.
   */
  quickAccess: "j3bots:quick-access",
  /** From the main process, to the quick access window's page: `QuickAccessCue`. */
  quickAccessCue: "j3bots:quick-access-cue",
  /**
   * `QuickAccessHide`, from the quick access window's page: it has left the
   * screen, hide the window. Not answered.
   */
  quickAccessHide: "j3bots:quick-access-hide",
  /**
   * `QuickAccessOpen`, from the quick access window's page: shows the main
   * window at that conversation, and hides quick access. Not answered.
   */
  quickAccessOpenMain: "j3bots:quick-access-open-main",
  /**
   * `QuickAccessPictureRequest`, from the quick access window's page only:
   * takes a picture of the window that was in front as that showing opened.
   * Answers `QuickAccessPicture`.
   */
  quickAccessPicture: "j3bots:quick-access-picture",
  /** Answers `LookingAtSettings`. */
  lookingAt: "j3bots:looking-at",
  /** `LookingAtChange`, answered with `LookingAtSettings`. */
  setLookingAt: "j3bots:set-looking-at",
  /**
   * Asks the system for the permission that reading windows needs (macOS:
   * Screen Recording), and opens where the operator gives it. Answers
   * `LookingAtSettings`.
   */
  askScreenAccess: "j3bots:ask-screen-access",
  /** Answers `ShortcutStatus`. */
  shortcut: "j3bots:shortcut",
  /** `ShortcutRequest`, answered with `ShortcutChange`. */
  setShortcut: "j3bots:set-shortcut",
  /** Runs the bots on this computer, and loads the page again on its server. Answers `UseThisComputerResult`. */
  useThisComputer: "j3bots:use-this-computer",
  /**
   * Stops the server on this computer, its data kept, forgets it, and loads
   * the page again on the server address screen. Answers `ModeChange`.
   */
  connectToServerInstead: "j3bots:connect-to-server-instead",
  /** `LocalDeviceRequest`, answered with `LocalDeviceResult` once the server is ready, or will not be. */
  localDevice: "j3bots:local-device",
  /** Answers `LocalServerState | null`. */
  localServer: "j3bots:local-server",
  /** From the main process, each time the local server's state changes: `LocalServerState | null`. */
  localServerChanged: "j3bots:local-server-changed",
  /** Starts the local server again now, after it failed or while it waits to restart. Not answered. */
  retryLocalServer: "j3bots:retry-local-server",
  /**
   * Tries again the update of the local server that failed and was rolled
   * back (`LocalServerState.update` is `rolled-back`). Not answered.
   */
  retryServerUpdate: "j3bots:retry-server-update",
  /** `PhoneAccessRequest`, answered with `PhoneAccessChange`. */
  setPhoneAccess: "j3bots:set-phone-access",
  /** Answers `PhoneAccess`, its addresses read again from the server. */
  phoneAccess: "j3bots:phone-access",
  /** From the main process, each time phone access changes: `PhoneAccess`. */
  phoneAccessChanged: "j3bots:phone-access-changed",
  /** `LocalPairingRequest`, answered with `LocalPairingLink`. */
  localPairingLink: "j3bots:local-pairing-link",
  /** `StartWithSystemRequest`, answered with `StartWithSystemChange`. */
  setStartWithSystem: "j3bots:set-start-with-system",
  /** `SignInRelayRequest`, answered with `SignInRelayStart`. */
  catchSignIn: "j3bots:catch-sign-in",
  /** `SignInExpectation`, answered with whether a listener on that port takes it. */
  expectSignIn: "j3bots:expect-sign-in",
  /** `SignInRelayStop`: stops catching on that port, if the app still is. Not answered. */
  stopCatchingSignIn: "j3bots:stop-catching-sign-in",
  /** From the main process, as the browser comes back from a sign-in: `SignInReturn`. */
  signInReturned: "j3bots:sign-in-returned",
  /** `SecretCopy`, answered with whether it reached the clipboard. */
  copySecret: "j3bots:copy-secret",
  /**
   * `LocalExportRequest`: asks where to write the export of the bots on this
   * computer, stops their server and writes it. Answers `LocalExportResult`.
   */
  exportLocal: "j3bots:export-local",
  /** Runs the bots that moved away from this computer here again. Answers `ModeChange`. */
  runHereAgain: "j3bots:run-here-again",
  /**
   * Deletes the data of the bots that moved away from this computer, and
   * loads the page again. Answers `ModeChange`.
   */
  deleteLocalData: "j3bots:delete-local-data",
  /** Answers `RecordingCheck`. */
  recordingCheck: "j3bots:recording-check",
  /** `RecordingAccessRequest`, answered with `RecordingCheck`. */
  recordingAccess: "j3bots:recording-access",
  /** `RecordingStart`, answered with `RecordingStartResult`. */
  startRecording: "j3bots:start-recording",
  /** `RecordingOpen`: shows the main window with the sheet on that conversation. Not answered. */
  openRecorder: "j3bots:open-recorder",
  /** The main window's page listens for recordings now: the app sends those it keeps. Not answered. */
  recordingsWanted: "j3bots:recordings-wanted",
  /** From the main process, to the main window's page: `RecordingDelivery`. */
  recording: "j3bots:recording",
  /** `RecordingRead`, answered with the bytes or `null`. */
  readRecording: "j3bots:read-recording",
  /**
   * `RecordingRead` of a recording's voice as it is kept for its transcript
   * (`RecorderChunk` `speech`), answered with the bytes or `null`.
   */
  readRecordingSpeech: "j3bots:read-recording-speech",
  /** `RecordingTranscriptKeep`, answered with the zip's size or `null`. */
  keepTranscript: "j3bots:keep-transcript",
  /** `RecordingRelease`. Not answered. */
  releaseRecording: "j3bots:release-recording",
  /** From the recorder's page only: answers `RecorderJob`, or `null` when nothing is to be recorded. */
  recorderJob: "j3bots:recorder-job",
  /** `RecorderStarted`, from the recorder's page. Not answered. */
  recorderStarted: "j3bots:recorder-started",
  /** `RecorderChunk`, from the recorder's page. Not answered. */
  recorderChunk: "j3bots:recorder-chunk",
  /** `RecorderFrame`, from the recorder's page. Not answered. */
  recorderFrame: "j3bots:recorder-frame",
  /** `RecorderControl`, from the recorder's page. Not answered. */
  recorderControl: "j3bots:recorder-control",
  /** `RecorderFailure`, from the recorder's page. Not answered. */
  recorderFailed: "j3bots:recorder-failed",
  /** From the main process, to the recorder's page: `RecorderCue`. */
  recorderCue: "j3bots:recorder-cue",
  /**
   * `BrowserLink`, from the main window's page: the server the browser serves,
   * as the page is signed in to it, or `null`. Not answered.
   */
  browserLink: "j3bots:browser-link",
  /** Answers `DesktopBrowserState`. */
  browserState: "j3bots:browser-state",
  /** From the main process, each time the browser changes: `DesktopBrowserState`. */
  browserChanged: "j3bots:browser-changed",
  /** `DesktopBrowserCommand`. Not answered: the browser's state follows. */
  browserCommand: "j3bots:browser-command",
  /** `BrowserPlacement`: where the window's page draws its place's front tab. Not answered. */
  browserPlace: "j3bots:browser-place",
  /** From the main process: `BrowserStill`, while the page covers the tab. */
  browserStill: "j3bots:browser-still",
  /** From the main process: `BrowserFound`, as finding in a page goes. */
  browserFound: "j3bots:browser-found",
  /** From the main process: `BrowserShortcut`, pressed while a tab's page had the keys. */
  browserShortcut: "j3bots:browser-shortcut",
  /** `BrowserSuggestRequest`, answered with the address bar's `BrowserSuggestion`s. */
  browserSuggest: "j3bots:browser-suggest",
  /** `BrowserPresence`, from the main window's page: who is on the browser's tabs. Not answered. */
  browserPresence: "j3bots:browser-presence",
} as const;

/** What the preload script puts on `window[BRIDGE_KEY]`. Its answers are decoded by the page. */
export interface DesktopBridge {
  readonly state: unknown;
  /** Connects to a server (a `ConnectRequest`). */
  readonly connect: (request: unknown) => Promise<unknown>;
  readonly forgetServer: () => Promise<unknown>;
  readonly sealToken: (token: string) => Promise<unknown>;
  readonly openToken: (sealed: string) => Promise<unknown>;
  readonly networkStatus: () => Promise<unknown>;
  /** Calls `listener` each time the system wakes from sleep; answers a function that stops it. */
  readonly onResumed: (listener: (state: unknown) => void) => () => void;
  /** Restarts the app; the page's storage is kept. */
  readonly relaunch: () => void;
  readonly updateStatus: () => Promise<unknown>;
  /** Calls `listener` each time the update's status changes; answers a function that stops it. */
  readonly onUpdate: (listener: (status: unknown) => void) => () => void;
  readonly checkForUpdates: () => void;
  readonly restartToUpdate: () => void;
  readonly cancelRestartToUpdate: () => void;
  /** Chooses the releases the app follows (an `UpdateChannelRequest`). */
  readonly setUpdateChannel: (channel: string) => Promise<unknown>;
  /** Turns installing a verified version by itself on or off (an `AutomaticUpdatesRequest`). */
  readonly setAutomaticUpdates: (on: boolean) => Promise<unknown>;
  readonly reportSaving: (saving: boolean) => void;
  /** Shows a notification (a `NotificationRequest`) on the system's screen. */
  readonly notify: (request: unknown) => void;
  /** Closes the notifications a pairing that ended received (a `CloseNotificationsRequest`). */
  readonly closeNotifications: (request: unknown) => void;
  /** Calls `listener` with each notification the operator clicks; answers a function that stops it. */
  readonly onNotificationClick: (listener: (click: unknown) => void) => () => void;
  /**
   * Calls `listener` with each link to the app the operator follows, starting
   * with any that arrived before; answers a function that stops it.
   */
  readonly onAppLink: (listener: (link: unknown) => void) => () => void;
  /** Tells the app the language the page shows (a `LanguageReport`). */
  readonly reportLanguage: (report: unknown) => void;
  /** Tells the app the appearance the operator chose (an `AppearanceReport`). */
  readonly reportAppearance: (report: unknown) => void;
  /** The theme the system is in (a `Theme`), whatever the app's window is set to. */
  readonly systemTheme: () => Promise<unknown>;
  /** Tells the app what the tray lists (a `TrayReport`). */
  readonly reportTray: (report: unknown) => void;
  /** Calls `listener` with each command from the app's menus or its tray; answers a function that stops it. */
  readonly onCommand: (listener: (command: unknown) => void) => () => void;
  /** Tells the app whether quick access has a primary bot to show (a `QuickAccessReport`). */
  readonly reportQuickAccess: (report: unknown) => void;
  /** Calls `listener` with each cue for quick access (a `QuickAccessCue`); answers a function that stops it. */
  readonly onQuickAccessCue: (listener: (cue: unknown) => void) => () => void;
  /** Hides the quick access window, once its page has left the screen (a `QuickAccessHide`). */
  readonly hideQuickAccess: (request: unknown) => void;
  /** Shows the main window at a conversation, and hides quick access (a `QuickAccessOpen`). */
  readonly openFromQuickAccess: (request: unknown) => void;
  /** A picture of the window that was in front (a `QuickAccessPictureRequest`). */
  readonly quickAccessPicture: (request: unknown) => Promise<unknown>;
  readonly lookingAt: () => Promise<unknown>;
  /** Changes what quick access reads of the window in front (a `LookingAtChange`). */
  readonly setLookingAt: (request: unknown) => Promise<unknown>;
  readonly askScreenAccess: () => Promise<unknown>;
  readonly shortcutStatus: () => Promise<unknown>;
  readonly setShortcut: (accelerator: string) => Promise<unknown>;
  readonly useThisComputer: () => Promise<unknown>;
  readonly connectToServerInstead: () => Promise<unknown>;
  /** Signs this computer in to its own server (a `LocalDeviceRequest`). */
  readonly localDevice: (request: unknown) => Promise<unknown>;
  /**
   * Calls `listener` with the local server's state now, then each time it
   * changes; answers a function that stops it.
   */
  readonly onLocalServer: (listener: (state: unknown) => void) => () => void;
  readonly retryLocalServer: () => void;
  readonly retryServerUpdate: () => void;
  /** Turns phone access on or off (a `PhoneAccessRequest`). */
  readonly setPhoneAccess: (request: unknown) => Promise<unknown>;
  /**
   * Calls `listener` with phone access now, then each time it changes;
   * answers a function that stops it.
   */
  readonly onPhoneAccess: (listener: (access: unknown) => void) => () => void;
  /** A pairing code for a phone (a `LocalPairingRequest`). */
  readonly localPairingLink: (request: unknown) => Promise<unknown>;
  readonly setStartWithSystem: (on: boolean) => Promise<unknown>;
  /**
   * Listens on this computer's loopback for the browser's return from a
   * connector's sign-in (a `SignInRelayRequest`), in place of any listener before.
   */
  readonly catchSignIn: (request: unknown) => Promise<unknown>;
  /** Tells the listener the sign-in's state (a `SignInExpectation`), before the browser opens it. */
  readonly expectSignIn: (request: unknown) => Promise<unknown>;
  /** Stops the listener on a port (a `SignInRelayStop`). */
  readonly stopCatchingSignIn: (request: unknown) => void;
  /** Calls `listener` with each return from a sign-in (a `SignInReturn`); answers a function that stops it. */
  readonly onSignInReturn: (listener: (signInReturn: unknown) => void) => () => void;
  /** Puts a secret's value on the clipboard, for a while (a `SecretCopy`). */
  readonly copySecret: (request: unknown) => Promise<unknown>;
  /** Moves the bots on this computer to another server (a `LocalExportRequest`). */
  readonly exportLocal: (request: unknown) => Promise<unknown>;
  readonly runHereAgain: () => Promise<unknown>;
  readonly deleteLocalData: () => Promise<unknown>;
  readonly recordingCheck: () => Promise<unknown>;
  /** Opens where the operator gives a permission (a `RecordingAccessRequest`). */
  readonly recordingAccess: (request: unknown) => Promise<unknown>;
  /** Starts recording (a `RecordingStart`). */
  readonly startRecording: (request: unknown) => Promise<unknown>;
  /** Opens the sheet in the main window (a `RecordingOpen`). */
  readonly openRecorder: (request: unknown) => void;
  /**
   * Calls `listener` with each recording for the page (a `RecordingDelivery`),
   * starting with those the app keeps; answers a function that stops it.
   */
  readonly onRecording: (listener: (delivery: unknown) => void) => () => void;
  /** Bytes of a recording (a `RecordingRead`). */
  readonly readRecording: (request: unknown) => Promise<unknown>;
  /** Bytes of a recording's voice kept for its transcript (a `RecordingRead`). */
  readonly readRecordingSpeech: (request: unknown) => Promise<unknown>;
  /** Puts a transcript in a recording, or settles it goes without (a `RecordingTranscriptKeep`). */
  readonly keepTranscript: (request: unknown) => Promise<unknown>;
  /** Lets the app delete a recording (a `RecordingRelease`). */
  readonly releaseRecording: (request: unknown) => void;
  readonly recorderJob: () => Promise<unknown>;
  /** The recorder's encoders started (a `RecorderStarted`). */
  readonly recorderStarted: (report: unknown) => void;
  /** What an encoder wrote (a `RecorderChunk`). */
  readonly recorderChunk: (chunk: unknown) => void;
  /** A picture the app asked for (a `RecorderFrame`). */
  readonly recorderFrame: (frame: unknown) => void;
  /** What the operator pressed on the recorder (a `RecorderControl`). */
  readonly recorderControl: (control: unknown) => void;
  /** The recorder could not record (a `RecorderFailure`). */
  readonly recorderFailed: (failure: unknown) => void;
  /** Calls `listener` with each cue for the recorder (a `RecorderCue`); answers a function that stops it. */
  readonly onRecorderCue: (listener: (cue: unknown) => void) => () => void;
  /** Tells the app which server its browser serves (a `BrowserLink`). */
  readonly linkBrowser: (link: unknown) => void;
  readonly browserState: () => Promise<unknown>;
  /** Calls `listener` with each `DesktopBrowserState`; answers a function that stops it. */
  readonly onBrowser: (listener: (state: unknown) => void) => () => void;
  /** A `DesktopBrowserCommand`. */
  readonly browserCommand: (command: unknown) => void;
  /** Where this window draws its front tab (a `BrowserPlacement`). */
  readonly placeBrowser: (placement: unknown) => void;
  /** Calls `listener` with each `BrowserStill`; answers a function that stops it. */
  readonly onBrowserStill: (listener: (still: unknown) => void) => () => void;
  /** Calls `listener` with each `BrowserFound`; answers a function that stops it. */
  readonly onBrowserFound: (listener: (found: unknown) => void) => () => void;
  /** Calls `listener` with each `BrowserShortcut`; answers a function that stops it. */
  readonly onBrowserShortcut: (listener: (shortcut: unknown) => void) => () => void;
  /** The address bar's suggestions for what is typed (a `BrowserSuggestRequest`). */
  readonly browserSuggest: (request: unknown) => Promise<unknown>;
  /** Tells the app who is on the browser's tabs (a `BrowserPresence`), for their pages to show. */
  readonly browserPresence: (presence: unknown) => void;
}
