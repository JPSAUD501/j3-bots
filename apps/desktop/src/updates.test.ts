// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import {
  initial as initialOn,
  mayCheck,
  step,
  type Step,
  type UpdateEvent,
  type UpdateMode,
  type Updates,
} from "./updates.ts";

const initial = (mode: UpdateMode) => initialOn(mode, "stable");

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

describe("updating the app", () => {
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
    expect(state.phase).toEqual({ _tag: "failed", stage: "install" });
    expect(mayCheck(state)).toBe(true);
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
});
