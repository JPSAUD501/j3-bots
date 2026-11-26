// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { ReceivedUpdateStatus } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { ServerUpdateStart } from "../client.ts";
import { Cell } from "../Store.ts";
import type { ClientSide, Snooze } from "./prompt.ts";
import type { ServerUpdateView, UpdateResult } from "./ServerUpdate.ts";
import { makeUpdatePrompt } from "./UpdatePrompt.ts";

const at = DateTime.makeUnsafe("2026-11-25T12:00:00Z");

const offering: ReceivedUpdateStatus = {
  api: 1,
  current: { version: "0.8.0", channel: "stable" },
  channel: "stable",
  available: {
    version: "0.9.0",
    channel: "stable",
    publishedAt: at,
    notesUrl: "https://example.test/releases/tag/v0.9.0",
    highlights: [],
    verified: true,
  },
  waitingForStable: false,
  refused: null,
  lastCheck: null,
  canUpdate: { _tag: "able" },
  state: { _tag: "idle" },
  run: null,
  lastResult: null,
};

const done: UpdateResult = {
  outcome: "done",
  from: "0.8.0",
  to: "0.9.0",
  at,
  by: null,
  reason: null,
  detail: null,
};

/** The status of a server whose update ran: on the new version, with how it ended. */
const updated: ReceivedUpdateStatus = {
  ...offering,
  current: { version: "0.9.0", channel: "stable" },
  available: null,
  lastResult: done,
};

/** A runner over fakes: what the server and the client were asked, and how to answer. */
const harness = (start: ServerUpdateStart = { _tag: "started" }) => {
  const view = new Cell<ServerUpdateView>({ _tag: "status", status: offering });
  const ended = new Cell<UpdateResult | null>(null);
  const side = new Cell<ClientSide>({ follow: "install", app: null, workItStops: 0 });
  const asked: Array<string> = [];
  let refreshed = 0;
  let kept: Snooze | null = null;
  let settleClient: (outcome: "current" | "failed") => void = () => {};
  const prompt = makeUpdatePrompt({
    server: {
      view,
      ended,
      dismissEnded: () => ended.set(null),
      refresh: () => {
        refreshed++;
      },
      start: (version, stopWork) => {
        asked.push(`server ${version}${stopWork ? " stopping work" : ""}`);
        // As the server does, the run is recorded before it answers.
        if (start._tag === "started") {
          view.set({
            _tag: "status",
            status: {
              ...offering,
              state: { _tag: "downloading", receivedBytes: 0, totalBytes: null },
            },
          });
        }
        return Promise.resolve(start);
      },
    },
    client: {
      side,
      update: (how) => {
        asked.push(`client ${how}`);
        return new Promise((resolve) => {
          settleClient = resolve;
        });
      },
      openDownload: (url) => asked.push(`download ${url}`),
    },
    snooze: {
      read: () => kept,
      write: (snooze) => {
        kept = snooze;
      },
    },
    now: () => 1_000,
  });
  return {
    prompt,
    view,
    ended,
    asked,
    refreshed: () => refreshed,
    kept: () => kept,
    settleClient: (o: "current" | "failed") => settleClient(o),
  };
};

/** Lets the callbacks of settled promises run. */
const tick = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

describe("the update prompt's runner", () => {
  it("starts the client only once the server answers that its update ended on the new version", async () => {
    const { prompt, view, ended, asked, settleClient } = harness();
    prompt.updateNow();
    await tick();
    assert.deepStrictEqual(asked, ["server 0.9.0"]);
    // Restarting: the server is silent, and the client waits.
    view.set({ _tag: "restarting", to: "0.9.0", last: offering });
    assert.deepStrictEqual(asked, ["server 0.9.0"]);
    // The first read that answers, a reconnect's as well as the follower's, ends it.
    view.set({ _tag: "status", status: updated });
    assert.deepStrictEqual(asked, ["server 0.9.0", "client install"]);
    // The follower's own report of the same end says nothing more.
    ended.set(done);
    assert.strictEqual(ended.get(), null);
    settleClient("current");
    await tick();
    assert.strictEqual(prompt.state.get().run._tag, "done");
  });

  it("reads the server again before trying again after losing sight of it, and goes on if it got there", async () => {
    const { prompt, view, asked, refreshed } = harness();
    prompt.updateNow();
    await tick();
    view.set({ _tag: "lost", to: "0.9.0", last: offering });
    prompt.retry();
    assert.strictEqual(refreshed(), 1);
    assert.deepStrictEqual(asked, ["server 0.9.0"]);
    view.set({ _tag: "status", status: updated });
    assert.deepStrictEqual(asked, ["server 0.9.0", "client install"]);
  });

  it("tries the app's part again at once, whatever the server answers meanwhile", async () => {
    const { prompt, view, asked, refreshed, settleClient } = harness();
    prompt.updateNow();
    await tick();
    view.set({ _tag: "status", status: updated });
    settleClient("failed");
    await tick();
    view.set({ _tag: "unreachable", last: updated });
    prompt.retry();
    assert.strictEqual(refreshed(), 0);
    assert.deepStrictEqual(asked, ["server 0.9.0", "client install", "client install"]);
  });

  it("leaves the client alone when the server goes silent for good", async () => {
    const { prompt, view, asked } = harness();
    prompt.updateNow();
    await tick();
    view.set({ _tag: "lost", to: "0.9.0", last: offering });
    assert.strictEqual(prompt.state.get().run._tag, "server-failed");
    assert.deepStrictEqual(asked, ["server 0.9.0"]);
  });

  it("asks before stopping the server's running work", async () => {
    const { prompt, asked } = harness({ _tag: "refused", reason: "work-running", runningBots: 3 });
    prompt.updateNow();
    await tick();
    assert.strictEqual(prompt.state.get().run._tag, "work-running");
    prompt.stopWork();
    await tick();
    assert.deepStrictEqual(asked, ["server 0.9.0", "server 0.9.0 stopping work"]);
  });

  it("keeps Later where the platform stores it", () => {
    const { prompt, kept } = harness();
    prompt.later();
    assert.deepStrictEqual(kept(), {
      until: 1_000 + 24 * 60 * 60 * 1000,
      server: "0.9.0",
      app: null,
    });
  });
});
