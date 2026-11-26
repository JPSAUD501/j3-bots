// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FAILURE_REASONS,
  Invalid,
  SECRET_NEED_REASONS,
  SecretName,
  SecretRefused,
  SIGN_IN_REASONS,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context } from "../../test/fixtures.ts";
import { connectFailureText, connectorStatusText } from "./connectors.ts";

const secret = SecretName.make("tracker-token");

const languages = ["en", "pt-BR"] as const;
const since = at("2026-11-20T14:00:00Z");

describe("connectorStatusText", () => {
  it.each(languages)(
    "words every reason a connector fails for in its own sentence (%s)",
    (lang) => {
      const ctx = context("2026-11-20T15:00:00Z", lang);
      const words = (reason: (typeof FAILURE_REASONS)[number] | "unknown") =>
        connectorStatusText({ _tag: "failing", reason, since }, ctx);
      const fallback = words("unknown").detail;
      const details = FAILURE_REASONS.map((reason) => words(reason).detail);
      // None falls back to the words for a reason this build does not know.
      expect(details).not.toContain(fallback);
      expect(new Set(details).size).toBe(FAILURE_REASONS.length);
      for (const reason of FAILURE_REASONS) expect(words(reason).since).not.toBeNull();
    },
  );

  it.each(languages)("says what to do about a command that cannot run (%s)", (lang) => {
    const ctx = context("2026-11-20T15:00:00Z", lang);
    const remote = connectorStatusText({ _tag: "failing", reason: "unreachable", since }, ctx);
    for (const reason of ["command-not-found", "command-exited", "command-refused"] as const) {
      const text = connectorStatusText({ _tag: "failing", reason, since }, ctx);
      expect(text.next).not.toBeNull();
      // It is not running, rather than out of reach.
      expect(text.label).not.toBe(remote.label);
    }
  });

  it.each(languages)("words every reason a connector needs a sign-in for (%s)", (lang) => {
    const ctx = context("2026-11-20T15:00:00Z", lang);
    const words = (reason: (typeof SIGN_IN_REASONS)[number] | "unknown") =>
      connectorStatusText({ _tag: "needs-sign-in", reason }, ctx).detail;
    const details = SIGN_IN_REASONS.map(words);
    expect(details).not.toContain(words("unknown"));
    expect(new Set(details).size).toBe(SIGN_IN_REASONS.length);
  });

  it.each(languages)(
    "names the secret a connector needs, and why, for every reason (%s)",
    (lang) => {
      const ctx = context("2026-11-20T15:00:00Z", lang);
      const words = (reason: (typeof SECRET_NEED_REASONS)[number] | "unknown") =>
        connectorStatusText({ _tag: "needs-secret", secret, reason }, ctx).detail;
      const details = SECRET_NEED_REASONS.map(words);
      expect(details).not.toContain(words("unknown"));
      expect(new Set(details).size).toBe(SECRET_NEED_REASONS.length);
      for (const detail of details) expect(detail).toContain(secret);
    },
  );
});

describe("connectFailureText", () => {
  it.each(languages)(
    "says a command was refused for a package at no exact version (%s)",
    (lang) => {
      const { i18n } = context("2026-11-20T15:00:00Z", lang);
      const refused = (reason: "command-unpinned" | "connector-fields") =>
        connectFailureText({ _tag: "refused", error: new Invalid({ reason }) }, i18n);
      expect(refused("command-unpinned")).not.toBe(refused("connector-fields"));
      expect(refused("command-unpinned")).toContain("@scope/server@1.2.3");
    },
  );

  it.each(languages)("names the secret a change was refused over, and why (%s)", (lang) => {
    const { i18n } = context("2026-11-20T15:00:00Z", lang);
    const problems = ["missing", "no-value", "not-shared", "not-yours", "destination"] as const;
    const texts = problems.map((problem) =>
      connectFailureText(
        { _tag: "secret-refused", error: new SecretRefused({ secret, problem }) },
        i18n,
      ),
    );
    for (const text of texts) expect(text).toContain(secret);
    const inAddress = connectFailureText(
      { _tag: "secret-refused", error: new SecretRefused({ secret, problem: "in-address" }) },
      i18n,
    );
    expect(
      new Set([...texts, inAddress, connectFailureText({ _tag: "unexpected" }, i18n)]).size,
    ).toBe(problems.length + 2);
  });
});
