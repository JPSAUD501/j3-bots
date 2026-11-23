// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalDeviceResult, LocalServerState } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { type Desktop, desktop } from "./desktop";

/** The desktop app, while the bots live on this computer and it has their server's address. */
export const localMode: Desktop | null =
  desktop !== null && desktop.mode === "local" && desktop.server !== null ? desktop : null;

/** The server on this computer as the page shows it: its state, and when a restart it waits for starts. */
export interface LocalServerView {
  readonly server: LocalServerState;
  readonly restartAt: DateTime.Utc | null;
}

const viewOf = (server: LocalServerState): LocalServerView => ({
  server,
  restartAt:
    server.state === "restarting" && server.retryInSeconds !== undefined
      ? DateTime.makeUnsafe(Date.now() + server.retryInSeconds * 1000)
      : null,
});

/** The server on this computer, followed while the component shows; `null` outside local mode. */
export function useLocalServer(): LocalServerView | null {
  const [view, setView] = useState<LocalServerView | null>(() =>
    localMode === null || localMode.localServer === null ? null : viewOf(localMode.localServer),
  );
  useEffect(
    () => localMode?.onLocalServer((server) => setView(server === null ? null : viewOf(server))),
    [],
  );
  return view;
}

let asking: Promise<LocalDeviceResult | null> | null = null;

/**
 * Asks the app to sign this computer in to its own server, once at a time: a
 * second ask while one is under way shares its answer, so this computer is
 * never signed in twice, as the app signs it in without being asked only
 * once (`LocalDeviceRequest`).
 */
export const askLocalDevice = (again: boolean): Promise<LocalDeviceResult | null> => {
  if (localMode === null) return Promise.resolve(null);
  if (asking !== null) return asking;
  const ask = localMode.localDevice(again).finally(() => {
    asking = null;
  });
  asking = ask;
  return ask;
};
