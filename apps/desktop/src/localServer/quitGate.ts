// SPDX-License-Identifier: AGPL-3.0-or-later

// Holding the app's quit until the server it runs has stopped, as T3 Code's
// desktop holds `before-quit` for its own (MIT; read at bc0f04d,
// `apps/desktop/src/app/DesktopLifecycle.ts`): Quit from the tray or the menu,
// the system shutting down, an update. The first request is held while the
// server stops; once it has, the app quits for real.

export interface QuitGateOptions {
  /** Whether a server runs, or is being started, that must stop first. */
  readonly serverRuns: () => boolean;
  /** Stops it; resolves once it has, or was killed. */
  readonly stopServer: () => Promise<void>;
  /** Asks the app to quit again, which the gate now lets through. */
  readonly quit: () => void;
}

/** A `before-quit` handler (and `powerMonitor`'s `shutdown`) that holds the quit while the server stops. */
export const quitGate = (options: QuitGateOptions) => {
  let state: "open" | "stopping" | "stopped" = "open";
  return (event: { readonly preventDefault: () => void }): void => {
    if (state === "stopped") return;
    if (state === "open" && !options.serverRuns()) {
      state = "stopped";
      return;
    }
    event.preventDefault();
    if (state === "stopping") return;
    state = "stopping";
    // The app quits whether the stop succeeded or failed: a quit the operator
    // asked for is never refused, and the server's stdin lifeline ends it.
    const quit = () => {
      state = "stopped";
      options.quit();
    };
    options.stopServer().then(quit, quit);
  };
};
