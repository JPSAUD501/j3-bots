// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import type { DeviceId, DeviceToken } from "@j3-bots/contracts";
import type { LocalDeviceResult } from "@j3-bots/desktop-bridge";

// What stands between the operator and the bots on this computer, in local
// mode: signing this computer in to its own server, and the screen shown in
// place of the shell until it can show.

/** How signing this computer in stands, past the first ask. */
export type LocalSignIn =
  | { readonly _tag: "idle" }
  /**
   * The server was not running: asked again once it is, as the operator
   * asked (`again`), or as the page did on its own.
   */
  | { readonly _tag: "waiting"; readonly again: boolean }
  /** This computer was signed in before: only the operator signs it in again. */
  | { readonly _tag: "signed-out" }
  | { readonly _tag: "failed" };

/** Whether this device has never been signed in here, as after the operator chose this computer. */
const isFresh = (connection: ConnectionState) =>
  connection._tag === "unpaired" && connection.reason === "new";

/**
 * Whether the page asks the app to sign this computer in without the operator
 * asking: only while this device has never held a credential here, and
 * again only once a server that was not running runs. A device that was
 * signed out, or refused, is never signed in again unasked.
 */
export const asksSilently = (
  connection: ConnectionState,
  signIn: LocalSignIn,
  serverReady: boolean,
): boolean =>
  isFresh(connection) && (signIn._tag === "idle" || (signIn._tag === "waiting" && serverReady));

/**
 * What an answer to signing in means: a credential to keep, for the server
 * the page runs on only, or how signing in stands now.
 */
export const signInAnswer = (
  result: LocalDeviceResult | null,
  {
    origin,
    serverReady,
    again,
  }: { readonly origin: string; readonly serverReady: boolean; readonly again: boolean },
):
  | { readonly _tag: "keep"; readonly deviceId: DeviceId; readonly token: DeviceToken }
  | LocalSignIn => {
  if (result === null) return { _tag: "failed" };
  switch (result._tag) {
    case "minted":
      return result.server === origin
        ? { _tag: "keep", deviceId: result.deviceId, token: result.token }
        : { _tag: "failed" };
    case "signed-out":
      return { _tag: "signed-out" };
    // A server that answers it is not running while it says it is ready will not change by waiting.
    case "not-running":
      return serverReady ? { _tag: "failed" } : { _tag: "waiting", again };
    case "failed":
      return { _tag: "failed" };
  }
};

/** The screen in place of the shell, or `shell` for the shell under the connection line. */
export type LocalScreen =
  | "stopping"
  | "signed-out"
  | "sign-in-failed"
  | "first-run"
  | "first-run-failed"
  | "shell";

export const localScreen = ({
  stopping,
  signIn,
  connection,
  firstRun,
  serverFailed,
}: {
  readonly stopping: boolean;
  readonly signIn: LocalSignIn;
  readonly connection: ConnectionState;
  readonly firstRun: boolean;
  readonly serverFailed: boolean;
}): LocalScreen => {
  if (stopping) return "stopping";
  if (signIn._tag === "failed") return "sign-in-failed";
  if (signIn._tag === "signed-out") return "signed-out";
  if (connection._tag === "unpaired" && connection.reason !== "new") return "signed-out";
  if (!firstRun) return "shell";
  return serverFailed ? "first-run-failed" : "first-run";
};
