// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import {
  checkFailed,
  initial as initialOn,
  mayCheck,
  step,
  type Step,
  type UpdateEvent,
  type UpdateMode,
  type Updates,
} from "./updates.ts";

/** A build in `mode` on the stable channel, "Update automatically" off: it installs only when asked. */
const initial = (mode: UpdateMode) => initialOn(mode, "stable", false);
/** The same with "Update automatically" on, as it is by default. */
const automatic = (mode: UpdateMode) => initialOn(mode, "stable", true);

/** Runs `events` from `from`, and answers where they lead and whether any step installed. */
const run = (from: Updates, events: ReadonlyArray<UpdateEvent>) =>
  events.reduce<{
    readonly state: Updates;
    readonly installs: number;
    readonly actions: ReadonlyArray<Step["action"]>;
  }>(
    ({ state, installs, actions }, event) => {
      const taken: Step = step(state, event);
      return {
        state: taken.next,
        installs: installs + (taken.action?._tag === "install" ? 1 : 0),
        actions: [...actions, taken.action],
      };
    },
    { state: from, installs: 0, actions: [] },
  );

const found: ReadonlyArray<UpdateEvent> = [
  { _tag: "check-started" },
  { _tag: "available", version: "0.0.2" },
  { _tag: "progress", percent: 40 },
  { _tag: "downloaded", version: "0.0.2" },
  { _tag: "verified", version: "0.0.2", matched: true },
];

describe("updating the app when the operator asks", () => {
  it("downloads a newer version in the background, then offers the restart", () => {
    const { state, installs } = run(initial("install"), found);
    expect(state.phase).toEqual({ _tag: "downloaded", version: "0.0.2", restart: "offered" });
    expect(installs).toBe(0);
  });

  it("restarts only once the operator asks", () => {
    const { state, installs } = run(initial("install"), [...found, { _tag: "restart-requested" }]);
    expect(state.phase).toEqual({ _tag: "installing", version: "0.0.2" });
    expect(installs).toBe(1);
  });

  it("never restarts while a save is under way, and restarts as soon as it ends", () => {
    const asked = run(initial("install"), [
      ...found,
      { _tag: "saving", saving: true },
      { _tag: "restart-requested" },
    ]);
    expect(asked.installs).toBe(0);
    expect(asked.state.phase).toEqual({
      _tag: "downloaded",
      version: "0.0.2",
      restart: "waiting-for-save",
    });
    const saved = run(asked.state, [{ _tag: "saving", saving: false }]);
    expect(saved.installs).toBe(1);
  });

  it("lets the operator call off a restart that waits for a save, and offers it again", () => {
    const { state, installs } = run(initial("install"), [
      ...found,
      { _tag: "saving", saving: true },
      { _tag: "restart-requested" },
      { _tag: "restart-cancelled" },
      { _tag: "saving", saving: false },
    ]);
    expect(installs).toBe(0);
    expect(state.phase).toEqual({ _tag: "downloaded", version: "0.0.2", restart: "offered" });
    // Called off, it is asked for again as before.
    expect(run(state, [{ _tag: "restart-requested" }]).installs).toBe(1);
    // There is nothing to call off once the restart is under way.
    const installing = run(initial("install"), [...found, { _tag: "restart-requested" }]).state;
    expect(run(installing, [{ _tag: "restart-cancelled" }]).state).toBe(installing);
  });

  it("does not restart when a save ends unless the operator asked", () => {
    const { installs } = run(initial("install"), [
      { _tag: "saving", saving: true },
      ...found,
      { _tag: "saving", saving: false },
    ]);
    expect(installs).toBe(0);
  });

  it("installs once however often the operator asks", () => {
    const { installs } = run(initial("install"), [
      ...found,
      { _tag: "restart-requested" },
      { _tag: "restart-requested" },
      { _tag: "saving", saving: false },
    ]);
    expect(installs).toBe(1);
  });

  it("ignores a restart asked for before anything is downloaded", () => {
    const { state, installs } = run(initial("install"), [
      { _tag: "check-started" },
      { _tag: "available", version: "0.0.2" },
      { _tag: "restart-requested" },
      { _tag: "downloaded", version: "0.0.2" },
      { _tag: "verified", version: "0.0.2", matched: true },
    ]);
    expect(installs).toBe(0);
    expect(state.phase).toEqual({ _tag: "downloaded", version: "0.0.2", restart: "offered" });
  });

  it("checks again after a failure, and not while a version is on its way or ready", () => {
    const failed = run(initial("install"), [{ _tag: "check-started" }, { _tag: "failed" }]).state;
    expect(failed.phase).toEqual({ _tag: "failed", stage: "check" });
    expect(mayCheck(failed)).toBe(true);
    expect(checkFailed(failed)).toBe(true);
    expect(mayCheck(run(initial("install"), found.slice(0, 2)).state)).toBe(false);
    expect(mayCheck(run(initial("install"), found.slice(0, 4)).state)).toBe(false);
    const ready = run(initial("install"), found).state;
    expect(mayCheck(ready)).toBe(false);
    // A stray error leaves a ready version ready.
    expect(run(ready, [{ _tag: "failed" }]).state.phase._tag).toBe("downloaded");
  });

  it("says an install that failed apart from a check that failed, and may try again", () => {
    const { state } = run(initial("install"), [
      ...found,
      { _tag: "restart-requested" },
      { _tag: "failed" },
    ]);
    expect(state.phase).toEqual({ _tag: "failed", stage: "install", version: "0.0.2" });
    expect(mayCheck(state)).toBe(true);
    // Trying again soon would fail the same way: only the schedule or the operator does.
    expect(checkFailed(state)).toBe(false);
  });

  it("only says a newer version is out in a build that does not install it", () => {
    const { state, installs } = run(initial("notify"), [
      { _tag: "check-started" },
      { _tag: "available", version: "0.0.2" },
      { _tag: "restart-requested" },
    ]);
    expect(state.phase).toEqual({ _tag: "released", version: "0.0.2" });
    expect(installs).toBe(0);
    // A later check finds a version newer still.
    const later = run(state, [
      { _tag: "check-started" },
      { _tag: "available", version: "0.0.3" },
    ]).state;
    expect(later.phase).toEqual({ _tag: "released", version: "0.0.3" });
  });

  it("says a check found nothing newer", () => {
    const { state } = run(initial("install"), [
      { _tag: "check-started" },
      { _tag: "not-available" },
    ]);
    expect(state.phase).toEqual({ _tag: "idle", checked: true });
  });

  it("does nothing in a build that cannot update itself", () => {
    const { state, installs } = run(initial("off"), [...found, { _tag: "restart-requested" }]);
    expect(state.phase._tag).toBe("unavailable");
    expect(installs).toBe(0);
  });

  it("checks a download against the release's signed checksums before it offers the restart", () => {
    const downloaded = run(initial("install"), found.slice(0, 4));
    expect(downloaded.state.phase).toEqual({ _tag: "verifying", version: "0.0.2" });
    expect(downloaded.actions.at(-1)).toEqual({ _tag: "verify", version: "0.0.2" });
    // Nothing installs before the verdict.
    const asked = run(downloaded.state, [{ _tag: "restart-requested" }]);
    expect(asked.installs).toBe(0);
    expect(asked.state.phase._tag).toBe("verifying");
  });

  it("refuses a download that does not match, and never offers it", () => {
    const { state, installs } = run(initial("install"), [
      ...found.slice(0, 4),
      { _tag: "verified", version: "0.0.2", matched: false },
      { _tag: "restart-requested" },
    ]);
    expect(state.phase).toEqual({ _tag: "failed", stage: "verify" });
    expect(installs).toBe(0);
    expect(mayCheck(state)).toBe(true);
  });

  it("takes no verdict on a version other than the one it checks", () => {
    const { state } = run(initial("install"), [
      ...found.slice(0, 4),
      { _tag: "verified", version: "0.0.1", matched: true },
    ]);
    expect(state.phase).toEqual({ _tag: "verifying", version: "0.0.2" });
  });

  it("follows another channel from scratch, dropping what the old one offered", () => {
    const ready = run(initial("install"), found).state;
    const { state, actions } = run(ready, [{ _tag: "channel-chosen", channel: "nightly" }]);
    expect(state.channel).toBe("nightly");
    expect(state.phase).toEqual({ _tag: "idle", checked: false });
    expect(actions).toEqual([{ _tag: "follow-channel" }]);
  });

  it("keeps its channel while a version is on its way or installing", () => {
    for (const events of [found.slice(0, 1), found.slice(0, 3), found.slice(0, 4)]) {
      const moving = run(initial("install"), events).state;
      const { state, actions } = run(moving, [{ _tag: "channel-chosen", channel: "nightly" }]);
      expect(state.channel).toBe("stable");
      expect(actions).toEqual([null]);
    }
  });
  it("does not install as it quits", () => {
    const { installs, actions } = run(initial("install"), [...found, { _tag: "quitting" }]);
    expect(installs).toBe(0);
    expect(actions.at(-1)).toBeNull();
  });
});

describe("updating the app by itself", () => {
  it("installs what the launch's check finds, and restarts into it with no click", () => {
    const { state, actions } = run(automatic("install"), found);
    expect(state.phase).toEqual({ _tag: "installing", version: "0.0.2" });
    expect(actions.at(-1)).toEqual({ _tag: "install" });
  });

  it("says the launch is updating from the moment a version is found until it restarts", () => {
    const launches = (events: ReadonlyArray<UpdateEvent>) =>
      run(automatic("install"), events).state.launch;
    expect(automatic("install").launch).toBe("checking");
    expect(launches(found.slice(0, 1))).toBe("checking");
    expect(launches(found.slice(0, 2))).toBe("updating");
    expect(launches(found.slice(0, 4))).toBe("updating");
  });

  it("opens as usual when the launch's check finds nothing, fails, or takes too long", () => {
    expect(
      run(automatic("install"), [{ _tag: "check-started" }, { _tag: "not-available" }]).state
        .launch,
    ).toBe("over");
    expect(
      run(automatic("install"), [{ _tag: "check-started" }, { _tag: "failed" }]).state.launch,
    ).toBe("over");
    const waited = run(automatic("install"), [
      { _tag: "check-started" },
      { _tag: "launch-wait-over" },
    ]).state;
    expect(waited.launch).toBe("over");
    // The check goes on, and what it finds late installs as the app quits, not now.
    const late = run(waited, found.slice(1));
    expect(late.installs).toBe(0);
    expect(late.state.phase).toEqual({ _tag: "downloaded", version: "0.0.2", restart: "offered" });
    expect(run(late.state, [{ _tag: "quitting" }]).actions).toEqual([{ _tag: "install-on-quit" }]);
  });

  it("takes no time limit on a version already found at launch", () => {
    const { state, installs } = run(automatic("install"), [
      ...found.slice(0, 3),
      { _tag: "launch-wait-over" },
      ...found.slice(3),
    ]);
    expect(state.launch).toBe("updating");
    expect(installs).toBe(1);
  });

  it("installs a version found while the app runs only as it quits", () => {
    const running = run(automatic("install"), [
      { _tag: "check-started" },
      { _tag: "not-available" },
      ...found,
    ]);
    expect(running.installs).toBe(0);
    expect(running.state.phase).toEqual({
      _tag: "downloaded",
      version: "0.0.2",
      restart: "offered",
    });
    const quit = run(running.state, [{ _tag: "quitting" }]);
    expect(quit.actions).toEqual([{ _tag: "install-on-quit" }]);
    expect(quit.state.phase).toEqual({ _tag: "installing", version: "0.0.2" });
    // The restart stays the operator's to ask for sooner.
    expect(run(running.state, [{ _tag: "restart-requested" }]).installs).toBe(1);
  });

  it("installs nothing as it quits before a download has matched", () => {
    const opened = run(automatic("install"), [
      { _tag: "check-started" },
      { _tag: "not-available" },
    ]).state;
    for (const events of [found.slice(0, 3), found.slice(0, 4)]) {
      const { actions } = run(run(opened, events).state, [{ _tag: "quitting" }]);
      expect(actions).toEqual([null]);
    }
  });

  it("waits for a save under way before it restarts at launch", () => {
    const saving = run(automatic("install"), [{ _tag: "saving", saving: true }, ...found]);
    expect(saving.installs).toBe(0);
    expect(saving.state.phase).toEqual({
      _tag: "downloaded",
      version: "0.0.2",
      restart: "waiting-for-save",
    });
    expect(run(saving.state, [{ _tag: "saving", saving: false }]).installs).toBe(1);
    // Called off, the page opens, and the version installs as the app quits.
    const cancelled = run(saving.state, [{ _tag: "restart-cancelled" }, { _tag: "quitting" }]);
    expect(cancelled.state.launch).toBe("over");
    expect(cancelled.actions).toEqual([null, { _tag: "install-on-quit" }]);
  });

  it("never installs a launch's download that did not match, and opens as usual", () => {
    const { state, installs } = run(automatic("install"), [
      ...found.slice(0, 4),
      { _tag: "verified", version: "0.0.2", matched: false },
      { _tag: "quitting" },
    ]);
    expect(installs).toBe(0);
    expect(state.phase).toEqual({ _tag: "failed", stage: "verify" });
    expect(state.launch).toBe("over");
  });

  it("opens as usual when the install at launch fails, and keeps it from repeating", () => {
    const { state } = run(automatic("install"), [...found, { _tag: "failed" }]);
    expect(state.phase).toEqual({ _tag: "failed", stage: "install", version: "0.0.2" });
    expect(state.launch).toBe("over");
    // The next check offers it again, and leaves the install to the quit.
    expect(run(state, found).installs).toBe(0);
  });

  it("stops installing by itself once the operator turns it off", () => {
    const running = run(automatic("install"), [
      { _tag: "check-started" },
      { _tag: "not-available" },
      ...found,
      { _tag: "automatic-chosen", on: false },
      { _tag: "quitting" },
    ]);
    expect(running.actions.at(-1)).toBeNull();
    expect(running.state.phase._tag).toBe("downloaded");
  });

  it("only says a newer version is out in a build that cannot install it", () => {
    const notify = automatic("notify");
    expect(notify.launch).toBe("over");
    const { state, installs } = run(notify, [
      { _tag: "check-started" },
      { _tag: "available", version: "0.0.2" },
      { _tag: "quitting" },
    ]);
    expect(state.phase).toEqual({ _tag: "released", version: "0.0.2" });
    expect(installs).toBe(0);
  });

  it("restarts into a version that waits to install when the page asks for a restart", () => {
    const opened = run(automatic("install"), [
      { _tag: "check-started" },
      { _tag: "not-available" },
    ]).state;
    const ready = run(opened, [...found, { _tag: "relaunch-requested" }]);
    expect(ready.actions.at(-1)).toEqual({ _tag: "install" });
    // Without one, it restarts as it is, and installs nothing found while it quits.
    const plain = run(opened, [
      ...found.slice(0, 4),
      { _tag: "relaunch-requested" },
      { _tag: "verified", version: "0.0.2", matched: true },
      { _tag: "quitting" },
    ]);
    expect(plain.actions.slice(-3)).toEqual([{ _tag: "relaunch" }, null, null]);
  });

  it("opens as usual when the launch's download stalls, and installs it as it quits", () => {
    const slow = run(automatic("install"), [
      ...found.slice(0, 3),
      { _tag: "launch-download-slow" },
    ]);
    expect(slow.state.launch).toBe("over");
    expect(slow.state.phase._tag).toBe("downloading");
    const done = run(slow.state, [...found.slice(3), { _tag: "quitting" }]);
    expect(done.actions).toEqual([
      { _tag: "verify", version: "0.0.2" },
      null,
      { _tag: "install-on-quit" },
    ]);
    // Once its download is in, the launch's update no longer gives way.
    const verifying = run(automatic("install"), [
      ...found.slice(0, 4),
      { _tag: "launch-download-slow" },
    ]).state;
    expect(verifying.launch).toBe("updating");
  });
});
