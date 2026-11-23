// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a React hook, which runs on the platform's timers, outside any Effect program.
// @effect-diagnostics globalDate:off -- a sign-in ends at the wall-clock time the server gave it.
import type { Connector, ConnectorId, SignInRedirect, SignInStarted } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ConnectorsClient } from "../client.ts";
import { type IntentFailure, type IntentResult, refusedWith } from "../intents/Actions.ts";
import type { SignInProblem } from "../presentation/connectors.ts";

/**
 * How this device brings the browser back from a connector's sign-in:
 * - `server`: to the server's own address, which takes it itself, as an
 *   `https:` one does;
 * - `relay`: to this device's loopback, where the app listens (`listen`
 *   answers the port, or null when it cannot) and hands what comes back to
 *   `onReturn`'s listener, which the hook relays to the server;
 * - `paste`: to a page no one answers, whose address the operator pastes.
 */
export type SignInRoute =
  | { readonly _tag: "server" }
  | {
      readonly _tag: "relay";
      readonly listen: () => Promise<number | null>;
      readonly onReturn: (listener: (url: string) => void) => () => void;
      readonly stop: () => void;
    }
  | { readonly _tag: "paste" };

/**
 * Where the sign-in stands. `waiting`: the browser has the sign-in page,
 * reached by `route`; for `paste`, `pasteRefused` says the last address
 * pasted was not one it returns to. `finishing`: what came back is on its
 * way to the server.
 */
export type SignInPhase =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting" }
  | {
      readonly _tag: "waiting";
      readonly route: SignInRoute["_tag"];
      readonly expiresAt: DateTime.Utc;
      readonly pasteRefused: boolean;
    }
  | {
      readonly _tag: "finishing";
      readonly route: SignInRoute["_tag"];
      readonly expiresAt: DateTime.Utc;
    }
  | { readonly _tag: "done" }
  | { readonly _tag: "failed"; readonly problem: SignInProblem };

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

const startProblem = (failure: IntentFailure): SignInProblem => {
  if (failure._tag === "not-paired") return "not-paired";
  if (refusedWith(failure, "vault-locked")) return "vault-locked";
  if (refusedWith(failure, "vault-not-set-up")) return "vault-not-set-up";
  if (refusedWith(failure, "sign-in-unsupported")) return "unsupported";
  if (refusedWith(failure, "registration-refused")) return "registration-refused";
  if (refusedWith(failure, "sign-in-unreachable")) return "unreachable";
  return "start-failed";
};

const finishProblem = (failure: IntentFailure): SignInProblem => {
  if (failure._tag === "not-paired") return "not-paired";
  if (failure._tag === "refused" && failure.error._tag === "NotFound") return "expired";
  if (refusedWith(failure, "vault-locked")) return "vault-locked";
  if (refusedWith(failure, "vault-not-set-up")) return "vault-not-set-up";
  if (refusedWith(failure, "sign-in-unreachable")) return "unreachable";
  if (failure._tag === "refused") return "refused";
  return "start-failed";
};

/**
 * A connector's sign-in from this device: it starts one on the server, opens
 * its page with `open`, and follows it to its end. The browser returns as
 * `route` says; a server that cannot take it back itself (`server`) is asked
 * again with `paste`. With `server`, the end is the connector reported
 * `connected` (`connector`, as the server reports it now). Every value that
 * comes back is handed to the server redacted, and none is kept.
 */
export function useConnectorSignIn(options: {
  readonly connectors: Pick<ConnectorsClient, "beginSignIn" | "completeSignIn">;
  readonly route: SignInRoute;
  readonly open: (url: string) => void;
  readonly connector: Connector | null;
}): ConnectorSignIn {
  const { connectors, route, open, connector } = options;
  const [phase, setPhase] = useState<SignInPhase>({ _tag: "idle" });
  // Each start and each cancel makes what an earlier attempt resolves with stale.
  const attempt = useRef(0);
  const started = useRef<SignInStarted | null>(null);
  const stopRelay = useRef<(() => void) | null>(null);

  const release = () => {
    stopRelay.current?.();
    stopRelay.current = null;
    started.current = null;
  };
  // A page that goes away stops listening for the browser, and lets the sign-in expire.
  const leave = useEffectEvent(release);
  useEffect(() => leave, []);

  const finish = (
    url: string,
    current: number,
    via: SignInRoute["_tag"],
    expiresAt: DateTime.Utc,
  ) => {
    setPhase({ _tag: "finishing", route: via, expiresAt });
    void connectors.completeSignIn(Redacted.make(url)).then((result: IntentResult) => {
      if (attempt.current !== current) return;
      if (result._tag === "done") {
        release();
        setPhase({ _tag: "done" });
      } else if (via === "paste" && refusedWith(result, "sign-in-url")) {
        setPhase({ _tag: "waiting", route: via, expiresAt, pasteRefused: true });
      } else {
        release();
        setPhase({ _tag: "failed", problem: finishProblem(result.failure) });
      }
    });
  };

  const begin = async (
    connectorId: ConnectorId,
    current: number,
  ): Promise<{
    readonly route: SignInRoute["_tag"];
    readonly result: IntentResult<SignInStarted>;
  }> => {
    if (route._tag === "relay") {
      const port = await route.listen();
      if (port === null) {
        return { route: "relay", result: { _tag: "failed", failure: { _tag: "unexpected" } } };
      }
      const stopListening = route.onReturn((url) => {
        const sign = started.current;
        if (attempt.current === current && sign !== null)
          finish(url, current, "relay", sign.expiresAt);
      });
      stopRelay.current = () => {
        stopListening();
        route.stop();
      };
      const redirect: SignInRedirect = { _tag: "relay", port };
      return { route: "relay", result: await connectors.beginSignIn(connectorId, redirect) };
    }
    if (route._tag === "server") {
      const result = await connectors.beginSignIn(connectorId, { _tag: "server" });
      if (!refusedWith(result, "no-server-redirect")) return { route: "server", result };
    }
    return { route: "paste", result: await connectors.beginSignIn(connectorId, { _tag: "paste" }) };
  };

  const start = (connectorId: ConnectorId) => {
    release();
    attempt.current += 1;
    const current = attempt.current;
    setPhase({ _tag: "starting" });
    void begin(connectorId, current).then(({ route: via, result }) => {
      if (attempt.current !== current) return;
      if (result._tag === "failed") {
        const relayed = via === "relay" && stopRelay.current === null;
        release();
        setPhase({ _tag: "failed", problem: relayed ? "no-relay" : startProblem(result.failure) });
        return;
      }
      started.current = result.value;
      setPhase({
        _tag: "waiting",
        route: via,
        expiresAt: result.value.expiresAt,
        pasteRefused: false,
      });
      open(Redacted.value(result.value.authorizationUrl));
    });
  };

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
  const expire = useEffectEvent((current: number) => {
    if (attempt.current !== current) return;
    attempt.current += 1;
    release();
    setPhase({ _tag: "failed", problem: "expired" });
  });
  useEffect(() => {
    if (expiresAt === null) return;
    const current = attempt.current;
    const timer = setTimeout(() => expire(current), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return {
    phase,
    start,
    openAgain: () => {
      if (started.current !== null) open(Redacted.value(started.current.authorizationUrl));
    },
    paste: (address) => {
      const sign = started.current;
      const trimmed = address.trim();
      if (phase._tag !== "waiting" || phase.route !== "paste" || sign === null || trimmed === "") {
        return;
      }
      finish(trimmed, attempt.current, "paste", sign.expiresAt);
    },
    cancel: () => {
      attempt.current += 1;
      release();
      setPhase({ _tag: "idle" });
    },
  };
}
