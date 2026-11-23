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
  /** From the main process, from its menus or its global shortcut: `ShellCommand`. */
  command: "j3bots:command",
  /** Answers `ShortcutStatus`. */
  shortcut: "j3bots:shortcut",
  /** `ShortcutRequest`, answered with `ShortcutChange`. */
  setShortcut: "j3bots:set-shortcut",
  /** Runs the bots on this computer, and loads the page again on its server. Answers `ModeChange`. */
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
  /** `PhoneAccessRequest`, answered with the `PhoneAccess` that holds after it. */
  setPhoneAccess: "j3bots:set-phone-access",
  /** Answers `LocalPairingLink`. */
  localPairingLink: "j3bots:local-pairing-link",
  /** `StartWithSystemRequest`, answered with `StartWithSystemChange`. */
  setStartWithSystem: "j3bots:set-start-with-system",
  /** `SignInRelayRequest`, answered with `SignInRelayStart`. */
  catchSignIn: "j3bots:catch-sign-in",
  /** Stops catching a sign-in, if one is caught. Not answered. */
  stopCatchingSignIn: "j3bots:stop-catching-sign-in",
  /** From the main process, as the browser comes back from a sign-in: `SignInReturn`. */
  signInReturned: "j3bots:sign-in-returned",
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
  /** Calls `listener` with each command from the app's menus or its shortcut; answers a function that stops it. */
  readonly onCommand: (listener: (command: unknown) => void) => () => void;
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
  readonly setPhoneAccess: (on: boolean) => Promise<unknown>;
  readonly localPairingLink: () => Promise<unknown>;
  readonly setStartWithSystem: (on: boolean) => Promise<unknown>;
  /**
   * Listens on this computer's loopback for the browser's return from a
   * connector's sign-in (a `SignInRelayRequest`), in place of any listener before.
   */
  readonly catchSignIn: (request: unknown) => Promise<unknown>;
  readonly stopCatchingSignIn: () => void;
  /** Calls `listener` with each return from a sign-in (a `SignInReturn`); answers a function that stops it. */
  readonly onSignInReturn: (listener: (signInReturn: unknown) => void) => () => void;
}
