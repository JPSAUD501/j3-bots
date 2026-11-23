// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorId, SignInRedirect, SignInStarted } from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import type { ConnectorsClient } from "../client.ts";
import { type IntentFailure, type IntentResult, refusedWith } from "../intents/Actions.ts";
import type { SignInProblem } from "../presentation/connectors.ts";

/**
 * How this device brings the browser back from a connector's sign-in:
 * - `server`: to the server's own address, which takes it itself, as an
 *   `https:` one does;
 * - `relay`: to this device's loopback, where the app listens (`listen`
 *   answers the port, or null when it cannot), takes only the return that
 *   carries the sign-in's state (`expect`, answering whether that listener
 *   still waits), and hands it to `onReturn`'s listener, which relays it to
 *   the server; `stop` closes the listener on a port;
 * - `paste`: to a page no one answers, whose address the operator pastes.
 */
export type SignInRoute =
  | { readonly _tag: "server" }
  | {
      readonly _tag: "relay";
      readonly listen: () => Promise<number | null>;
      readonly expect: (port: number, state: Redacted.Redacted<string>) => Promise<boolean>;
      readonly onReturn: (listener: (url: string) => void) => () => void;
      readonly stop: (port: number) => void;
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

/** The `state` the server put in a sign-in's address, which only its own return carries. */
const stateOf = (started: SignInStarted): Redacted.Redacted<string> | null => {
  const state = new URL(Redacted.value(started.authorizationUrl)).searchParams.get("state");
  return state === null || state === "" ? null : Redacted.make(state);
};

/** One sign-in, from its start to its end; nothing it does outlives `cancel`. */
export interface SignInAttempt {
  /** Hands over the address the operator pasted, while the sign-in waits for one. */
  readonly paste: (address: string) => void;
  /** Opens the sign-in page again, once it has one. */
  readonly openAgain: () => void;
  /**
   * Lets go of it: no phase is reported after, the browser is not opened,
   * and a listener it opened, or opens later, is closed. The server lets the
   * sign-in expire.
   */
  readonly cancel: () => void;
}

/**
 * Starts a sign-in to `connectorId` on the server, and follows it: each
 * phase goes to `report`, and its page to `open` once the server answers,
 * and, for `relay`, once the app's listener knows the sign-in's state.
 * Every value that comes back is handed to the server redacted, and none is
 * kept.
 */
export function startSignIn(options: {
  readonly connectors: Pick<ConnectorsClient, "beginSignIn" | "completeSignIn">;
  readonly route: SignInRoute;
  readonly connectorId: ConnectorId;
  readonly report: (phase: SignInPhase) => void;
  readonly open: (url: string) => void;
}): SignInAttempt {
  const { connectors, route, connectorId, report, open } = options;
  let live = true;
  let started: SignInStarted | null = null;
  let phase: SignInPhase = { _tag: "starting" };
  // What closes this attempt's listener, once it opened one.
  let stopListening: (() => void) | null = null;

  const set = (next: SignInPhase) => {
    if (!live) return;
    phase = next;
    report(next);
  };
  const release = () => {
    stopListening?.();
    stopListening = null;
  };
  const fail = (problem: SignInProblem) => {
    release();
    set({ _tag: "failed", problem });
  };

  const finish = (url: string, via: SignInRoute["_tag"], expiresAt: DateTime.Utc) => {
    set({ _tag: "finishing", route: via, expiresAt });
    void connectors.completeSignIn(Redacted.make(url)).then((result: IntentResult) => {
      if (!live) return;
      if (result._tag === "done") {
        release();
        set({ _tag: "done" });
      } else if (via === "paste" && refusedWith(result, "sign-in-url")) {
        set({ _tag: "waiting", route: via, expiresAt, pasteRefused: true });
      } else {
        fail(finishProblem(result.failure));
      }
    });
  };

  const waitFor = (via: SignInRoute["_tag"], sign: SignInStarted) => {
    started = sign;
    set({ _tag: "waiting", route: via, expiresAt: sign.expiresAt, pasteRefused: false });
    open(Redacted.value(sign.authorizationUrl));
  };

  const relay = async (relayRoute: Extract<SignInRoute, { readonly _tag: "relay" }>) => {
    const port = await relayRoute.listen();
    if (port === null) return fail("no-relay");
    const stopReturns = relayRoute.onReturn((url) => {
      if (live && started !== null && phase._tag === "waiting") {
        finish(url, "relay", started.expiresAt);
      }
    });
    stopListening = () => {
      stopReturns();
      relayRoute.stop(port);
    };
    // Cancelled while the app opened it: close it now, since nothing else will.
    if (!live) return release();
    const redirect: SignInRedirect = { _tag: "relay", port };
    const result = await connectors.beginSignIn(connectorId, redirect);
    if (!live) return release();
    if (result._tag === "failed") return fail(startProblem(result.failure));
    const state = stateOf(result.value);
    if (state === null || !(await relayRoute.expect(port, state))) return fail("no-relay");
    if (!live) return release();
    waitFor("relay", result.value);
  };

  const elsewhere = async () => {
    if (route._tag === "server") {
      const result = await connectors.beginSignIn(connectorId, { _tag: "server" });
      if (!live) return;
      if (!refusedWith(result, "no-server-redirect")) {
        return result._tag === "done"
          ? waitFor("server", result.value)
          : fail(startProblem(result.failure));
      }
    }
    const result = await connectors.beginSignIn(connectorId, { _tag: "paste" });
    if (!live) return;
    if (result._tag === "done") waitFor("paste", result.value);
    else fail(startProblem(result.failure));
  };

  report(phase);
  void (route._tag === "relay" ? relay(route) : elsewhere());

  return {
    paste: (address) => {
      const trimmed = address.trim();
      if (!live || started === null || phase._tag !== "waiting" || phase.route !== "paste") return;
      if (trimmed !== "") finish(trimmed, "paste", started.expiresAt);
    },
    openAgain: () => {
      if (live && started !== null) open(Redacted.value(started.authorizationUrl));
    },
    cancel: () => {
      live = false;
      release();
    },
  };
}
