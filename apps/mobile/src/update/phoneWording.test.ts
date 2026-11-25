// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import { verifySums } from "@j3-bots/release";
import { TEST_PUBLIC_KEY, VERIFICATION_CASES } from "@j3-bots/release/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import type { AppUpdateState } from "./appUpdate.ts";
import { phoneBehindLine, phoneNoticeLine } from "./phoneWording.ts";
import { signatureCheck } from "./signature.ts";

const i18n = createI18n("en");

/** A release the app may update to, its signed list verified with the test key. */
const release = (): Extract<AppUpdateState, { _tag: "available" }>["release"] => {
  const [signed] = VERIFICATION_CASES;
  if (signed?.signature == null) throw new Error("The first case is a signed release.");
  const verified = verifySums({
    version: signed.version,
    sums: new TextEncoder().encode(signed.sums),
    signature: new TextEncoder().encode(signed.signature),
    check: signatureCheck([TEST_PUBLIC_KEY]),
  });
  if (Result.isFailure(verified)) throw new Error("The first case verifies.");
  return {
    version: signed.version,
    channel: "stable",
    notesUrl: `https://example.com/releases/${signed.version}`,
    highlights: [],
    apk: { url: "https://example.com/app.apk", sha256: "0".repeat(64) },
    sums: verified.success,
  };
};

describe("the app's line on the screen that says it is behind its server", () => {
  it("never says the app is up to date, and points a stable app to nightly", () => {
    const current = { _tag: "current", waitingForStable: false } as const;
    expect(phoneBehindLine(current, "stable", i18n)).toMatchObject({
      text: i18n.t("phoneUpdate.behind.noRelease"),
      hint: i18n.t("phoneUpdate.behind.nightlyHint"),
    });
    expect(phoneBehindLine(current, "nightly", i18n)).toMatchObject({
      text: i18n.t("phoneUpdate.behind.noRelease"),
      hint: null,
    });
  });

  it("says a nightly app on stable waits for a newer stable release", () => {
    expect(
      phoneBehindLine({ _tag: "current", waitingForStable: true }, "stable", i18n),
    ).toMatchObject({ hint: i18n.t("phoneUpdate.waitingForStable") });
  });
});

describe("the app's update in the notice over the roster", () => {
  const offered = release();

  it("shows how an update under way goes, with nothing to hide", () => {
    expect(
      phoneNoticeLine({ _tag: "downloading", release: offered, received: 50, total: 100 }, i18n),
    ).toEqual({
      line: expect.objectContaining({
        text: i18n.t("serverUpdate.downloading", { version: offered.version, percent: 50 }),
      }),
      release: null,
    });
    expect(
      phoneNoticeLine({ _tag: "installing", release: offered, unattended: true }, i18n),
    ).toEqual({
      line: expect.objectContaining({
        text: i18n.t("phoneUpdate.installing.unattended", { version: offered.version }),
      }),
      release: null,
    });
  });

  it("says an update that did not go through or waits, hidden for its version", () => {
    const failed: AppUpdateState = {
      _tag: "failed",
      release: offered,
      failure: { _tag: "conflict" },
    };
    expect(phoneNoticeLine(failed, i18n)).toEqual({
      line: expect.objectContaining({ text: i18n.t("phoneUpdate.failure.conflict") }),
      release: offered.version,
    });
    expect(phoneNoticeLine({ _tag: "cancelled", release: offered }, i18n)?.release).toBe(
      offered.version,
    );
    expect(phoneNoticeLine({ _tag: "permission", release: offered }, i18n)?.line.text).toBe(
      i18n.t("phoneUpdate.permission.title"),
    );
  });

  it("says nothing of a check that found nothing to install", () => {
    expect(phoneNoticeLine({ _tag: "current", waitingForStable: false }, i18n)).toBeNull();
    expect(
      phoneNoticeLine({ _tag: "failed", release: null, failure: { _tag: "unreachable" } }, i18n),
    ).toBeNull();
  });
});
