// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import type { ReceivedUpdateStatus } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { serverBehindLine } from "./update.ts";

const i18n = createI18n("en");
const at = DateTime.makeUnsafe("2026-11-24T12:00:00Z");

/** A server on 0.3.1 that found nothing newer at its last check. */
const nothingNewer: ReceivedUpdateStatus = {
  api: 1,
  current: { version: "0.3.1", channel: "stable" },
  channel: "stable",
  available: null,
  waitingForStable: false,
  refused: null,
  lastCheck: { at, failure: null, nextAt: DateTime.add(at, { hours: 6 }) },
  canUpdate: { _tag: "able" },
  state: { _tag: "idle" },
  run: null,
  lastResult: null,
};

const said = (status: ReceivedUpdateStatus) => ({ _tag: "status", status }) as const;

describe("serverBehindLine", () => {
  it("says there is no newer release only after a check this client asked for has ended", () => {
    expect(serverBehindLine(said(nothingNewer), false, i18n)).toMatchObject({
      text: i18n.t("update.checking"),
      tone: "working",
    });
    expect(serverBehindLine(said(nothingNewer), true, i18n)).toMatchObject({
      text: i18n.t("gate.incompatible.serverBehindNoRelease"),
      offer: null,
    });
  });

  it("gives a server that cannot update from here the command for its machine, never up to date", () => {
    const line = serverBehindLine(
      said({
        ...nothingNewer,
        canUpdate: { _tag: "unable", reason: "started-by-hand", command: "j3-bots update" },
      }),
      true,
      i18n,
    );
    expect(line).toMatchObject({
      text: i18n.t("serverUpdate.unable.startedByHand"),
      command: "j3-bots update",
    });
  });

  it("says why the check found nothing when it failed", () => {
    expect(
      serverBehindLine(
        said({ ...nothingNewer, lastCheck: { at, failure: "unreachable", nextAt: at } }),
        true,
        i18n,
      ),
    ).toMatchObject({ text: i18n.t("serverUpdate.checkFailed") });
  });
});
