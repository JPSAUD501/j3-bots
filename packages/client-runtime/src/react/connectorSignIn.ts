// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a React hook, which runs on the platform's timers, outside any Effect program.
// @effect-diagnostics globalDate:off -- a sign-in ends at the wall-clock time the server gave it.
import type { Connector, ConnectorId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ConnectorsClient } from "../client.ts";
import {
  type SignInAttempt,
  type SignInPhase,
  type SignInRoute,
  startSignIn,
} from "./signInAttempt.ts";

export type { SignInPhase, SignInRoute } from "./signInAttempt.ts";

export interface ConnectorSignIn {
  readonly phase: SignInPhase;
  /** Starts a sign-in to the connector, in place of any under way, and opens it. */
  readonly start: (connectorId: ConnectorId) => void;
  /** Opens the sign-in page again, as when the browser did not open it or it was closed. */
  readonly openAgain: () => void;
  /** Hands over the address the operator pasted (`paste`). */
  readonly paste: (address: string) => void;
  /** Lets go of the sign-in; the server lets it expire. */
  readonly cancel: () => void;
}

/**
 * A connector's sign-in from this device (`startSignIn`), for as long as the
 * component that holds it: one that goes away lets go of it, so nothing it
 * started opens the browser or listens for it after. With `server`, the end
 * is the connector reported `connected` (`connector`, as the server reports
 * it now).
 */
export function useConnectorSignIn(options: {
  readonly connectors: Pick<ConnectorsClient, "beginSignIn" | "completeSignIn">;
  readonly route: SignInRoute;
  readonly open: (url: string) => void;
  readonly connector: Connector | null;
}): ConnectorSignIn {
  const { connectors, route, open, connector } = options;
  const [phase, setPhase] = useState<SignInPhase>({ _tag: "idle" });
  const attempt = useRef<SignInAttempt | null>(null);

  const letGo = () => {
    attempt.current?.cancel();
    attempt.current = null;
  };
  const leave = useEffectEvent(letGo);
  useEffect(() => leave, []);

  // The server took the browser back itself: the sign-in is done once the connector works.
  const signedIn = connector?.status._tag === "connected";
  // Stored during render, as React allows for state derived from a previous render. A
  // sign-in the server takes back has no listener of this device's to stop.
  if (phase._tag === "waiting" && phase.route === "server" && signedIn) setPhase({ _tag: "done" });

  // A sign-in the browser never came back from ends when the server lets it go.
  const expiresAt =
    phase._tag === "waiting" || phase._tag === "finishing"
      ? DateTime.toEpochMillis(phase.expiresAt)
      : null;
  const expire = useEffectEvent((expiring: SignInAttempt | null) => {
    if (expiring === null || attempt.current !== expiring) return;
    letGo();
    setPhase({ _tag: "failed", problem: "expired" });
  });
  useEffect(() => {
    if (expiresAt === null) return;
    const expiring = attempt.current;
    const timer = setTimeout(() => expire(expiring), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return {
    phase,
    start: (connectorId) => {
      letGo();
      attempt.current = startSignIn({ connectors, route, connectorId, report: setPhase, open });
    },
    openAgain: () => attempt.current?.openAgain(),
    paste: (address) => attempt.current?.paste(address),
    cancel: () => {
      letGo();
      setPhase({ _tag: "idle" });
    },
  };
}
