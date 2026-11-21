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
} as const;

/** What the preload script puts on `window[BRIDGE_KEY]`. Its answers are decoded by the page. */
export interface DesktopBridge {
  readonly state: unknown;
  readonly connect: (address: string) => Promise<unknown>;
  readonly forgetServer: () => Promise<unknown>;
  readonly sealToken: (token: string) => Promise<unknown>;
  readonly openToken: (sealed: string) => Promise<unknown>;
  readonly networkStatus: () => Promise<unknown>;
  /** Calls `listener` each time the system wakes from sleep; answers a function that stops it. */
  readonly onResumed: (listener: (state: unknown) => void) => () => void;
  /** Restarts the app; the page's storage is kept. */
  readonly relaunch: () => void;
}
