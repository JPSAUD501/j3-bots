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
  /** `UploadStart`, posted with the `MessagePort` the upload's `UPLOAD_TAGS` messages travel on. */
  upload: "j3bots:upload",
} as const;

/**
 * The messages of one upload, each an object with this `_tag`. The main
 * process asks for the body a chunk at a time (`pull`), and the preload
 * script answers with the next one (`chunk`, with its `bytes`) or `end`. As
 * each chunk is handed to the network, the main process says how many bytes
 * have gone (`progress`, with `sent`), and it ends with the server's answer
 * (`answered`) or `failed`. Closing the port aborts the upload.
 */
export const UPLOAD_TAGS = {
  pull: "pull",
  chunk: "chunk",
  end: "end",
  progress: "progress",
  answered: "answered",
  failed: "failed",
} as const;

/** An upload under way: its outcome, decoded by the page, and a way to stop it. */
export interface UploadHandle {
  readonly done: Promise<unknown>;
  readonly abort: () => void;
}

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
  /** Sends `body` as `request` asks, calling `onProgress` with how many bytes have gone. */
  readonly upload: (
    request: unknown,
    body: Blob,
    onProgress: (sent: unknown) => void,
  ) => UploadHandle;
}
