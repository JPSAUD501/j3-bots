// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import { LocalDeviceResult } from "@j3-bots/desktop-bridge";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { asksSilently, localScreen, type LocalSignIn, signInAnswer } from "./localGate";

const HERE = "http://127.0.0.1:41733";
const decode = Schema.decodeUnknownSync(LocalDeviceResult);
const minted = (server: string) =>
  decode({ _tag: "minted", server, deviceId: "dev_7KQ2M9XH4D", token: "t".repeat(43) });

const at = (serverReady: boolean) => ({ origin: HERE, serverReady, again: false });

const fresh: ConnectionState = { _tag: "unpaired", reason: "new" };
const signedOut: ConnectionState = { _tag: "unpaired", reason: "signed-out" };
const connected: ConnectionState = { _tag: "connected" };
const idle: LocalSignIn = { _tag: "idle" };
const waiting: LocalSignIn = { _tag: "waiting", again: false };

describe("signing this computer in without asking", () => {
  it("asks for a device that never had a credential here, as the server starts", () => {
    expect(asksSilently(fresh, idle, false)).toBe(true);
  });

  it("asks again only once a server that was not running runs", () => {
    expect(asksSilently(fresh, waiting, false)).toBe(false);
    expect(asksSilently(fresh, waiting, true)).toBe(true);
  });

  it("never signs in again a device that was signed out or refused", () => {
    expect(asksSilently(signedOut, idle, true)).toBe(false);
    expect(asksSilently({ _tag: "unpaired", reason: "still-listed" }, idle, true)).toBe(false);
    expect(asksSilently(fresh, { _tag: "signed-out" }, true)).toBe(false);
    expect(asksSilently(fresh, { _tag: "failed" }, true)).toBe(false);
    expect(asksSilently(connected, idle, true)).toBe(false);
  });
});

describe("an answer to signing in", () => {
  it("keeps a credential for the server the page runs on", () => {
    expect(signInAnswer(minted(HERE), at(true))).toMatchObject({ _tag: "keep" });
  });

  it("keeps none for another server", () => {
    expect(signInAnswer(minted("http://127.0.0.1:41734"), at(true))).toEqual({ _tag: "failed" });
  });

  it("waits for a server that is still starting, but not for one that says it runs", () => {
    const notRunning = decode({ _tag: "not-running" });
    expect(signInAnswer(notRunning, at(false))).toEqual({ _tag: "waiting", again: false });
    expect(signInAnswer(notRunning, at(true))).toEqual({ _tag: "failed" });
  });

  it("asks again as the operator asked, once the server runs", () => {
    const notRunning = decode({ _tag: "not-running" });
    expect(signInAnswer(notRunning, { ...at(false), again: true })).toEqual({
      _tag: "waiting",
      again: true,
    });
  });

  it("leaves a signed-out computer to the operator, and fails with no answer", () => {
    expect(signInAnswer(decode({ _tag: "signed-out" }), at(true))).toEqual({
      _tag: "signed-out",
    });
    expect(signInAnswer(null, at(true))).toEqual({ _tag: "failed" });
  });
});

describe("the screen in place of the shell", () => {
  const base = {
    stopping: false,
    signIn: idle,
    connection: connected,
    firstRun: false,
    serverFailed: false,
  };

  it("shows the shell once there are bots, even while the server is down", () => {
    expect(localScreen({ ...base, serverFailed: true })).toBe("shell");
  });

  it("goes on with the first run while the server starts, and says when it failed", () => {
    expect(localScreen({ ...base, connection: fresh, firstRun: true })).toBe("first-run");
    expect(localScreen({ ...base, connection: fresh, firstRun: true, serverFailed: true })).toBe(
      "first-run-failed",
    );
  });

  it("asks the operator to sign in once this computer was signed out", () => {
    expect(localScreen({ ...base, connection: signedOut })).toBe("signed-out");
    expect(localScreen({ ...base, connection: fresh, signIn: { _tag: "signed-out" } })).toBe(
      "signed-out",
    );
    expect(localScreen({ ...base, connection: fresh, signIn: { _tag: "failed" } })).toBe(
      "sign-in-failed",
    );
  });

  it("says it is stopping above everything else", () => {
    expect(
      localScreen({ ...base, stopping: true, signIn: { _tag: "failed" }, firstRun: true }),
    ).toBe("stopping");
  });
});
