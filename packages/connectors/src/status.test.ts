// SPDX-License-Identifier: AGPL-3.0-or-later
import { SecretName } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import {
  AuthFailing,
  NotMcp,
  SecretNeeded,
  ServerError,
  StepNotFinished,
  TimedOut,
  Unreachable,
} from "./errors.ts";
import { nextFailing, observe, statusOf } from "./status.ts";

const first = DateTime.makeUnsafe("2026-11-20T12:00:00Z");
const later = DateTime.makeUnsafe("2026-11-20T12:05:00Z");

describe("statusOf", () => {
  it("puts unreadable secrets before a secret it needs, that before a sign-in, and a sign-in before a failing server", () => {
    const failing = Option.some({ reason: "unreachable" as const, since: first });
    const need = Option.some({
      secret: SecretName.make("tracker-token"),
      reason: "not-shared" as const,
    });
    const signIn = Option.some("expired" as const);
    expect(statusOf({ secretsUnavailable: true, secretNeed: need, signIn, failing })._tag).toBe(
      "secrets-unavailable",
    );
    expect(statusOf({ secretsUnavailable: false, secretNeed: need, signIn, failing })).toEqual({
      _tag: "needs-secret",
      secret: "tracker-token",
      reason: "not-shared",
    });
    const none = Option.none();
    expect(statusOf({ secretsUnavailable: false, secretNeed: none, signIn, failing })).toEqual({
      _tag: "needs-sign-in",
      reason: "expired",
    });
    expect(
      statusOf({ secretsUnavailable: false, secretNeed: none, signIn: Option.none(), failing }),
    ).toEqual({
      _tag: "failing",
      reason: "unreachable",
      since: first,
    });
  });
});

describe("observe", () => {
  it("counts credentials a service refused, or a sign-in that moved, against the connector, and a scope missing or a step left unfinished against no one", () => {
    const secret = SecretName.make("builds-client-secret");
    expect(observe(new SecretNeeded({ secret, reason: "refused" }), "call")).toEqual({
      _tag: "secret-refused",
      secret,
    });
    // A secret its settings need reaches the connector from the secrets.
    expect(observe(new SecretNeeded({ secret, reason: "missing" }), "call")._tag).toBe("unchanged");
    expect(observe(new AuthFailing({ reason: "issuer-changed" }), "call")).toEqual({
      _tag: "failing",
      reason: "issuer-changed",
    });
    expect(observe(new AuthFailing({ reason: "scope-refused" }), "call")._tag).toBe("unchanged");
    expect(observe(new StepNotFinished({ outcome: "declined" }), "call")._tag).toBe("unchanged");
  });

  it("counts a slow or refused call against the call, and the same while connecting against the server", () => {
    expect(observe(new TimedOut(), "call")._tag).toBe("unchanged");
    expect(observe(new ServerError({ status: 400 }), "call")._tag).toBe("unchanged");
    expect(observe(new TimedOut(), "connect")).toEqual({ _tag: "failing", reason: "timed-out" });
    expect(observe(new ServerError({ status: 400 }), "connect")).toEqual({
      _tag: "failing",
      reason: "server-error",
    });
  });

  it("counts a server error or a lost server against the server even during a call", () => {
    expect(observe(new ServerError({ status: 503 }), "call")).toEqual({
      _tag: "failing",
      reason: "server-error",
    });
    expect(observe(new Unreachable({ reason: "closed" }), "call")).toEqual({
      _tag: "failing",
      reason: "unreachable",
    });
  });
});

describe("nextFailing", () => {
  it("keeps when the trouble started, and clears it on the next answer", () => {
    const once = nextFailing(Option.none(), observe(new NotMcp(), "connect"), first);
    const twice = nextFailing(once, observe(new Unreachable({ reason: "dns" }), "connect"), later);
    expect(twice).toEqual(Option.some({ reason: "unreachable", since: first }));
    expect(nextFailing(twice, { _tag: "answered" }, later)).toEqual(Option.none());
  });
});
