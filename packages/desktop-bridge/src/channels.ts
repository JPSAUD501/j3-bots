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
} as const;

/** What the preload script puts on `window[BRIDGE_KEY]`. Its answers are decoded by the page. */
export interface DesktopBridge {
  readonly state: unknown;
  readonly connect: (address: string) => Promise<unknown>;
  readonly forgetServer: () => Promise<unknown>;
}
