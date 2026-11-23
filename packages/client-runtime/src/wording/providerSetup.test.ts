// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { endpointInstead, signInLine } from "./providerSetup.ts";

describe("a sign-in from the app, in words", () => {
  const en = createI18n("en");

  it("says a stored endpoint still serves the models after the harness signed in", () => {
    expect(
      signInLine("claude-code", { _tag: "succeeded", endpoint: "https://proxy.example.com" }, en)
        ?.text,
    ).toBe(
      "Claude Code is signed in, but the endpoint at https://proxy.example.com is still connected, and bots reach their models through it while it is.",
    );
  });

  it("reads a reason a newer server gives as a plain failure", () => {
    expect(signInLine("codex", { _tag: "failed", reason: "unknown" }, en)).toEqual({
      text: "Codex’s sign-in didn’t work. Try again.",
      tone: "blocked",
    });
  });

  it("points to an endpoint only where signing in again cannot help", () => {
    expect(endpointInstead({ _tag: "failed", reason: "needs-terminal" })).toBe(true);
    expect(endpointInstead({ _tag: "failed", reason: "no-credential" })).toBe(true);
    expect(endpointInstead({ _tag: "failed", reason: "timed-out" })).toBe(false);
  });
});
