// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  type AppRelease,
  type ClientSide,
  entry,
  initial,
  type Prompt,
  type PromptEvent,
  type PromptInput,
  type Release,
  SNOOZE_MS,
  shown,
  step,
} from "./prompt.ts";
import type { UpdateResult } from "./ServerUpdate.ts";

const release = (version: string): Release => ({
  version,
  notesUrl: `https://example.test/releases/tag/v${version}`,
  highlights: ["A bot keeps a garden"],
});
const app = (version: string, how: AppRelease["how"] = "install"): AppRelease => ({
  ...release(version),
  how,
});

const desktop: ClientSide = { follow: "install", app: null, workItStops: 0 };
const browser: ClientSide = { follow: "reload", app: null, workItStops: 0 };

const result = (outcome: UpdateResult["outcome"], to = "0.9.0"): UpdateResult => ({
  outcome,
  from: "0.8.0",
  to,
  at: DateTime.makeUnsafe("2026-11-25T12:00:00Z"),
  by: null,
  reason: outcome === "done" ? null : "health-check",
  detail: null,
});

/** Runs `events` from `from`, returning each step's action and the state at the end. */
const run = (from: Prompt, events: ReadonlyArray<PromptEvent>) => {
  let prompt = from;
  const actions = events.map((event) => {
    const next = step(prompt, event);
    prompt = next.next;
    return next.action;
  });
  return { prompt, actions };
};

const NOW = 1_000_000;
const start = initial(null);

describe("the update prompt's sequence", () => {
  it("updates the server first, waits for it to answer on the new version, then the client", () => {
    const { prompt, actions } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-ended", result: result("done") },
    ]);
    assert.deepStrictEqual(actions, [
      { _tag: "start-server", version: "0.9.0", stopWork: false },
      { _tag: "update-client", how: "install" },
    ]);
    assert.strictEqual(prompt.run._tag, "client");
  });

  it("reloads a page that comes with the server, once the server is on the new version", () => {
    const { actions } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: browser, now: NOW },
      { _tag: "server-ended", result: result("done") },
    ]);
    assert.deepStrictEqual(actions[1], { _tag: "update-client", how: "reload" });
  });

  it("stops at a server update that rolled back, never touching the client, and tries again from the server", () => {
    const { prompt, actions } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-ended", result: result("rolled-back") },
    ]);
    assert.deepStrictEqual(actions[1], null);
    assert.strictEqual(prompt.run._tag, "server-failed");
    const again = step(prompt, {
      _tag: "retry",
      server: release("0.9.0"),
      client: desktop,
      now: NOW,
    });
    assert.deepStrictEqual(again.action, {
      _tag: "start-server",
      version: "0.9.0",
      stopWork: false,
    });
  });

  it("stops when the update ended on another version than the one asked for", () => {
    const { prompt } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-ended", result: result("done", "0.9.1") },
    ]);
    assert.strictEqual(prompt.run._tag, "server-failed");
  });

  it("stops when the server could not be reached or went silent", () => {
    for (const failure of ["server-unreachable", "server-lost"] as const) {
      const { prompt } = run(start, [
        { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
        { _tag: failure },
      ]);
      assert.strictEqual(prompt.run._tag, "server-failed");
    }
  });

  it("asks before stopping the server's running work, and starts again stopping it only on the operator's word", () => {
    const { prompt, actions } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-refused", reason: "work-running", runningBots: 2 },
    ]);
    assert.deepStrictEqual(prompt.run._tag === "work-running" && prompt.run.runningBots, 2);
    assert.strictEqual(actions[1], null);
    assert.deepStrictEqual(step(prompt, { _tag: "stop-work" }).action, {
      _tag: "start-server",
      version: "0.9.0",
      stopWork: true,
    });
  });

  it("runs the app's part alone when the server is current", () => {
    const { prompt, actions } = run(start, [
      {
        _tag: "update-now",
        server: null,
        client: { ...desktop, app: app("0.9.0") },
        now: NOW,
      },
    ]);
    assert.deepStrictEqual(actions, [{ _tag: "update-client", how: "install" }]);
    assert.strictEqual(prompt.run._tag, "client");
  });

  it("asks before an app restart stops the bots that run on this computer", () => {
    const local: ClientSide = { follow: "install", app: app("0.9.0"), workItStops: 1 };
    const { prompt, actions } = run(start, [
      { _tag: "update-now", server: null, client: local, now: NOW },
    ]);
    assert.deepStrictEqual(actions, [null]);
    assert.strictEqual(prompt.run._tag === "work-running" && prompt.run.side, "client");
    assert.deepStrictEqual(step(prompt, { _tag: "stop-work" }).action, {
      _tag: "update-client",
      how: "install",
    });
  });

  it("ends done when the server updated and the client has nothing newer to install", () => {
    const { prompt } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-ended", result: result("done") },
      { _tag: "client-current" },
    ]);
    assert.strictEqual(prompt.run._tag, "done");
    assert.strictEqual(step(prompt, { _tag: "hide" }).next.run._tag, "idle");
  });

  it("ends done right after the server for a client updated another way", () => {
    const { prompt, actions } = run(start, [
      {
        _tag: "update-now",
        server: release("0.9.0"),
        client: { follow: "none", app: null, workItStops: 0 },
        now: NOW,
      },
      { _tag: "server-ended", result: result("done") },
    ]);
    assert.strictEqual(actions[1], null);
    assert.strictEqual(prompt.run._tag, "done");
  });

  it("tries the client's part again without updating the server twice", () => {
    const { prompt } = run(start, [
      { _tag: "update-now", server: release("0.9.0"), client: desktop, now: NOW },
      { _tag: "server-ended", result: result("done") },
      { _tag: "client-failed" },
    ]);
    assert.strictEqual(prompt.run._tag, "client-failed");
    assert.deepStrictEqual(
      step(prompt, { _tag: "retry", server: null, client: desktop, now: NOW }).action,
      { _tag: "update-client", how: "install" },
    );
  });

  it("opens the download page for a build that cannot install itself, and rests as after Later", () => {
    const { prompt, actions } = run(start, [
      {
        _tag: "update-now",
        server: null,
        client: { follow: "none", app: app("0.9.0", "download"), workItStops: 0 },
        now: NOW,
      },
    ]);
    assert.deepStrictEqual(actions, [
      { _tag: "open-download", url: "https://example.test/releases/tag/v0.9.0" },
    ]);
    assert.deepStrictEqual(prompt.snooze, { until: NOW + SNOOZE_MS, server: null, app: "0.9.0" });
  });
});

describe("who sees the update prompt, and when", () => {
  const offered: PromptInput = {
    paired: true,
    blocked: false,
    server: release("0.9.0"),
    app: null,
    now: NOW,
  };

  it("opens for a paired device when the server or the app has a release, and for nobody else", () => {
    assert.isTrue(shown(start, offered));
    assert.isTrue(shown(start, { ...offered, server: null, app: app("0.9.0") }));
    assert.isFalse(shown(start, { ...offered, paired: false }));
    assert.isFalse(shown(start, { ...offered, server: null }));
  });

  it("opens nothing of its own over a screen that already asks, but keeps a sequence under way there", () => {
    assert.isFalse(shown(start, { ...offered, blocked: true }));
    const underWay = step(start, {
      _tag: "update-now",
      server: release("0.9.0"),
      client: desktop,
      now: NOW,
    }).next;
    assert.isTrue(shown(underWay, { ...offered, blocked: true, server: null }));
  });

  it("stays closed after Later for a day, for those versions, and leaves the quiet entry point", () => {
    const later = step(start, { _tag: "later", now: NOW, server: "0.9.0", app: null }).next;
    assert.isFalse(shown(later, offered));
    assert.deepStrictEqual(entry(later, offered), { _tag: "offer", version: "0.9.0" });
    assert.isFalse(shown(later, { ...offered, now: NOW + SNOOZE_MS - 1 }));
    assert.isTrue(shown(later, { ...offered, now: NOW + SNOOZE_MS }));
  });

  it("opens again before the day is out when a newer release comes, on either side", () => {
    const later = step(start, { _tag: "later", now: NOW, server: "0.9.0", app: null }).next;
    assert.isTrue(shown(later, { ...offered, server: release("0.9.1") }));
    assert.isTrue(shown(later, { ...offered, app: app("0.9.0") }));
  });

  it("opens again at once from the quiet entry point", () => {
    const later = step(start, { _tag: "later", now: NOW, server: "0.9.0", app: null }).next;
    assert.isTrue(shown(step(later, { _tag: "reopen" }).next, offered));
  });

  it("can be put aside while a part runs, and comes back when the sequence needs the operator", () => {
    const underWay = step(start, {
      _tag: "update-now",
      server: release("0.9.0"),
      client: desktop,
      now: NOW,
    }).next;
    const aside = step(underWay, { _tag: "hide" }).next;
    assert.isFalse(shown(aside, offered));
    assert.deepStrictEqual(entry(aside, offered), { _tag: "running" });
    const failed = step(aside, { _tag: "server-ended", result: result("rolled-back") }).next;
    assert.isTrue(shown(failed, offered));
  });

  it("cannot be snoozed while the server is updating", () => {
    const underWay = step(start, {
      _tag: "update-now",
      server: release("0.9.0"),
      client: desktop,
      now: NOW,
    }).next;
    assert.strictEqual(
      step(underWay, { _tag: "later", now: NOW, server: "0.9.0", app: null }).next,
      underWay,
    );
  });
});
