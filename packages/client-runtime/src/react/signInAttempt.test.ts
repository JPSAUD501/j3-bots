// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a test waits out the platform's promise jobs, outside any Effect program.
import { ConnectorId, type SignInRedirect, type SignInStarted } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import type { IntentResult } from "../intents/Actions.ts";
import { type SignInPhase, type SignInRoute, startSignIn } from "./signInAttempt.ts";

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}
const deferred = <A>(): Deferred<A> => {
  let resolve: (value: A) => void = () => {};
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
/** Lets every promise already settled run what waits on it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const PORT = 51734;
const connectorId = ConnectorId.make("conn_testconnector0000");
const started: SignInStarted = {
  authorizationUrl: Redacted.make("https://auth.example.com/authorize?state=s1"),
  expiresAt: at("2026-11-24T12:10:00Z"),
};

/** A server whose answers wait until the test gives them, and a record of what reached the device. */
const harness = () => {
  const begun = deferred<IntentResult<SignInStarted>>();
  const listening = deferred<number | null>();
  const redirects: Array<SignInRedirect> = [];
  const completed: Array<string> = [];
  const expected: Array<readonly [number, string]> = [];
  const stopped: Array<number> = [];
  const opened: Array<string> = [];
  const phases: Array<SignInPhase["_tag"]> = [];
  let returned: ((url: string) => void) | null = null;
  const relay: SignInRoute = {
    _tag: "relay",
    listen: () => listening.promise,
    expect: (port, state) => {
      expected.push([port, Redacted.value(state)]);
      return Promise.resolve(true);
    },
    onReturn: (listener) => {
      returned = listener;
      return () => {
        returned = null;
      };
    },
    stop: (port) => stopped.push(port),
  };
  const start = (route: SignInRoute) =>
    startSignIn({
      connectors: {
        beginSignIn: (_id, redirect) => {
          redirects.push(redirect);
          return begun.promise;
        },
        completeSignIn: (url) => {
          completed.push(Redacted.value(url));
          return Promise.resolve({ _tag: "done", value: undefined });
        },
      },
      route,
      connectorId,
      report: (phase) => phases.push(phase._tag),
      open: (url) => opened.push(url),
    });
  return {
    begun,
    listening,
    relay,
    start,
    redirects,
    completed,
    expected,
    stopped,
    opened,
    phases,
    browserReturns: (url: string) => returned?.(url),
  };
};

describe("a connector's sign-in", () => {
  it("through the desktop app: the listener learns the state, then the browser opens, then the return is relayed", async () => {
    const test = harness();
    test.start(test.relay);
    test.listening.resolve(PORT);
    await settle();
    expect(test.redirects).toEqual([{ _tag: "relay", port: PORT }]);
    test.begun.resolve({ _tag: "done", value: started });
    await settle();
    expect(test.expected).toEqual([[PORT, "s1"]]);
    expect(test.opened).toEqual(["https://auth.example.com/authorize?state=s1"]);
    test.browserReturns(`http://127.0.0.1:${PORT}/oauth/callback?code=c&state=s1`);
    await settle();
    expect(test.completed).toEqual([`http://127.0.0.1:${PORT}/oauth/callback?code=c&state=s1`]);
    expect(test.phases).toEqual(["starting", "waiting", "finishing", "done"]);
    expect(test.stopped).toEqual([PORT]);
  });

  it("let go of while the app opens its listener closes that listener, and opens nothing", async () => {
    const test = harness();
    test.start(test.relay).cancel();
    test.listening.resolve(PORT);
    await settle();
    expect(test.stopped).toEqual([PORT]);
    expect(test.redirects).toEqual([]);
    expect(test.opened).toEqual([]);
    expect(test.phases).toEqual(["starting"]);
  });

  it("let go of while the server starts it closes the listener, and opens nothing", async () => {
    const test = harness();
    const attempt = test.start(test.relay);
    test.listening.resolve(PORT);
    await settle();
    attempt.cancel();
    expect(test.stopped).toEqual([PORT]);
    test.begun.resolve({ _tag: "done", value: started });
    await settle();
    expect(test.expected).toEqual([]);
    expect(test.opened).toEqual([]);
    // A return that comes anyway is not relayed.
    test.browserReturns(`http://127.0.0.1:${PORT}/oauth/callback?code=c&state=s1`);
    await settle();
    expect(test.completed).toEqual([]);
    expect(test.stopped).toEqual([PORT]);
  });

  it("let go of before the server answers, from a browser, opens nothing", async () => {
    const test = harness();
    test.start({ _tag: "paste" }).cancel();
    test.begun.resolve({ _tag: "done", value: started });
    await settle();
    expect(test.opened).toEqual([]);
    expect(test.phases).toEqual(["starting"]);
  });
});
