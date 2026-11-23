// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, type BotState, type NotificationKind } from "@j3-bots/contracts";
import { avatarFrame } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { at, preview } from "../../test/fixtures.ts";
import {
  avatarFace,
  avatarMood,
  avatarSeed,
  avatarStates,
  createAvatar,
  gazeToward,
  notificationState,
  plainTraits,
  setAvatarState,
  speakingUntil,
  stepAvatar,
  stillFace,
  type AvatarSim,
  type AvatarState,
} from "./avatar.ts";

const since = at("2026-11-20T10:00:00Z");
const working: BotState = {
  _tag: "working",
  since,
  stalled: false,
  quietSince: null,
  activity: null,
  tool: null,
};
const quiet = { unread: false, speaking: false, offline: false };

describe("avatarMood", () => {
  it("shows a turn under way as thinking or working, and an idle bot as idle", () => {
    expect(avatarMood({ _tag: "idle" }, quiet)).toEqual({ state: "idle", stalled: false });
    expect(
      avatarMood({ _tag: "thinking", since, stalled: false, quietSince: null }, quiet).state,
    ).toBe("thinking");
    expect(avatarMood(working, quiet).state).toBe("working");
  });

  it("shows an idle bot with something unread as unread, and a busy one as busy", () => {
    expect(avatarMood({ _tag: "idle" }, { ...quiet, unread: true }).state).toBe("unread");
    expect(avatarMood(working, { ...quiet, unread: true }).state).toBe("working");
  });

  it("lets a bot speak over its turn, but never over what waits on the operator", () => {
    const speaking = { ...quiet, speaking: true };
    expect(avatarMood(working, speaking).state).toBe("speaking");
    expect(avatarMood({ _tag: "idle" }, { ...speaking, unread: true }).state).toBe("speaking");
    expect(
      avatarMood({ _tag: "waiting", entryId: EntryId.make("q"), since: null }, speaking).state,
    ).toBe("waiting");
    expect(
      avatarMood({ _tag: "blocked", failure: "usage-limit", retryAt: null }, speaking).state,
    ).toBe("blocked");
  });

  it("shows every bot asleep while the client cannot see the server", () => {
    expect(
      avatarMood(
        { _tag: "waiting", entryId: EntryId.make("q"), since: null },
        { ...quiet, offline: true },
      ),
    ).toEqual({ state: "offline", stalled: false });
  });

  it("holds a stalled turn still, thinking or working alike", () => {
    expect(avatarMood({ ...working, stalled: true }, quiet)).toEqual({
      state: "working",
      stalled: true,
    });
    expect(
      avatarMood({ _tag: "thinking", since, stalled: true, quietSince: since }, quiet).stalled,
    ).toBe(true);
  });
});

describe("notificationState", () => {
  it.each(["question", "approval", "secret-request"] as const)(
    "shows a %s as waiting on the operator, though the roster still has the bot working",
    (kind: NotificationKind) => {
      expect(notificationState({ kind }, working)).toBe("waiting");
    },
  );

  it.each(["message", "handoff"] as const)(
    "shows a %s as unread, even while the turn goes on",
    (kind: NotificationKind) => {
      expect(notificationState({ kind }, working)).toBe("unread");
      expect(notificationState({ kind }, { _tag: "idle" })).toBe("unread");
    },
  );

  it("shows a blocked bot as blocked, and one waiting on another card as waiting", () => {
    const blocked: BotState = { _tag: "blocked", failure: "usage-limit", retryAt: null };
    expect(notificationState({ kind: "message" }, blocked)).toBe("blocked");
    expect(
      notificationState(
        { kind: "message" },
        { _tag: "waiting", entryId: EntryId.make("q"), since: null },
      ),
    ).toBe("waiting");
  });
});

/** What a still face shows of its state, at `px`: the eye, the light and the signal. */
function cues(state: AvatarState, stalled = false, px = 40) {
  const face = stillFace(state, plainTraits, stalled);
  const frame = avatarFrame("dome", face, px);
  const eye = !frame.open
    ? "shut"
    : face.lidTop + face.lidBottom >= 0.6
      ? "slit"
      : face.pupil >= 8
        ? "wide"
        : face.lidTop >= 0.25
          ? "lidded"
          : "open";
  return {
    eye,
    smiling: face.cheek > 0,
    light: face.light,
    cut: frame.lightCut > frame.light.r,
    signal: face.signal,
    asleep: face.asleep,
  };
}

describe("still forms", () => {
  const plain = { smiling: false, light: "body", cut: false, signal: null, asleep: false } as const;
  const expected: Record<AvatarState, ReturnType<typeof cues>> = {
    idle: { ...plain, eye: "open" },
    thinking: { ...plain, eye: "lidded", signal: "dots" },
    working: { ...plain, eye: "slit", signal: "ring" },
    waiting: { ...plain, eye: "wide", light: "waiting", cut: true, signal: "ping" },
    blocked: { ...plain, eye: "shut", light: "blocked", cut: true },
    unread: { ...plain, eye: "open", smiling: true, light: "foreground", cut: true },
    speaking: { ...plain, eye: "open", signal: "arcs" },
    offline: { ...plain, eye: "shut", asleep: true },
  };

  it.each(avatarStates)("show %s by its eye, its light and its signal", (state) => {
    expect(cues(state)).toEqual(expected[state]);
  });

  it("show no two states alike", () => {
    const shown = new Set(avatarStates.map((state) => JSON.stringify(cues(state))));
    expect(shown.size).toBe(avatarStates.length);
  });

  it("set a state's light apart from the body at every size", () => {
    for (const px of [24, 40, 96]) {
      expect(cues("blocked", false, px).cut).toBe(true);
      expect(cues("idle", false, px).cut).toBe(false);
    }
  });

  it.each(["thinking", "working"] as const)(
    "drop the signal of a stalled %s turn, keeping its eye",
    (state) => {
      expect(cues(state, true)).toEqual({ ...expected[state], signal: null });
    },
  );
});

/** `sim` stepped at 60 fps for `seconds`. */
const run = (sim: AvatarSim, seconds: number) => {
  let next = sim;
  for (let i = 0; i < Math.round(seconds * 60); i++) next = stepAvatar(next, 1 / 60, null);
  return next;
};

describe("an avatar's variation", () => {
  it("comes from the bot's id, the same on every run", () => {
    expect(avatarSeed("bot-1")).toBe(avatarSeed("bot-1"));
    expect(avatarSeed("bot-1")).not.toBe(avatarSeed("bot-2"));
    expect(run(createAvatar(avatarSeed("bot-1"), "idle"), 3)).toEqual(
      run(createAvatar(avatarSeed("bot-1"), "idle"), 3),
    );
  });

  it("keeps two bots out of step", () => {
    const a = createAvatar(avatarSeed("bot-1"), "working");
    const b = createAvatar(avatarSeed("bot-2"), "working");
    expect(a.traits).not.toEqual(b.traits);
    expect(avatarFace(run(a, 1)).gazeX).not.toBeCloseTo(avatarFace(run(b, 1)).gazeX, 2);
  });

  it("blinks on its own within a few seconds", () => {
    let sim = createAvatar(avatarSeed("bot-1"), "idle");
    let blinked = false;
    for (let i = 0; i < 8 * 60 && !blinked; i++) {
      sim = stepAvatar(sim, 1 / 60, null);
      blinked = avatarFace(sim).blink > 0.5;
    }
    expect(blinked).toBe(true);
  });
});

describe("a change of state", () => {
  const seed = avatarSeed("bot-1");

  it("eases into the new pose within a second", () => {
    const sim = run(setAvatarState(createAvatar(seed, "idle"), "working"), 1.2);
    const face = avatarFace(sim);
    const pose = stillFace("working");
    expect(face.lidTop).toBeCloseTo(pose.lidTop, 2);
    expect(face.pupil).toBeCloseTo(pose.pupil, 2);
  });

  it("kicks the body once, its own way: a hop up for waiting, a slump for blocked", () => {
    const idle = createAvatar(seed, "idle");
    expect(setAvatarState(idle, "waiting").hop.v).toBeLessThan(0);
    expect(setAvatarState(idle, "blocked").hop.v).toBeGreaterThan(0);
    expect(setAvatarState(idle, "idle")).toBe(idle);
  });

  it("settles its springs after the kick", () => {
    const sim = run(setAvatarState(createAvatar(seed, "idle"), "blocked"), 4);
    expect(Math.abs(sim.hop.x)).toBeLessThan(0.5);
    expect(Math.abs(sim.lagX.x)).toBeLessThan(0.5);
  });
});

describe("gazeToward", () => {
  it("looks straight at the pointer, reaching the eye's edge from 220 px", () => {
    expect(gazeToward(440, 0)).toEqual({ x: 1, y: 0 });
    const near = gazeToward(0, 110);
    expect(near.x).toBeCloseTo(0, 6);
    expect(near.y).toBeCloseTo(0.5, 6);
  });
});

describe("speakingUntil", () => {
  const id = BotId.make("ada");
  it("lets a bot speak for a while after its own message arrives, longer for a longer one", () => {
    const short = preview("2026-11-20T10:00:00Z", "message", "Hi", { _tag: "bot", botId: id });
    const long = preview("2026-11-20T10:00:00Z", "message", "x".repeat(90), {
      _tag: "bot",
      botId: id,
    });
    const sent = DateTime.toEpochMillis(at("2026-11-20T10:00:00Z"));
    const until = speakingUntil(short, id);
    expect(until).toBeGreaterThan(sent);
    expect(speakingUntil(long, id)).toBeGreaterThan(until ?? Infinity);
  });

  it("does not for the operator's message, another bot's, or a card", () => {
    expect(speakingUntil(preview("2026-11-20T10:00:00Z"), id)).toBeNull();
    expect(
      speakingUntil(
        preview("2026-11-20T10:00:00Z", "message", "Hi", {
          _tag: "bot",
          botId: BotId.make("bea"),
        }),
        id,
      ),
    ).toBeNull();
    expect(
      speakingUntil(
        preview("2026-11-20T10:00:00Z", "question", "Which?", { _tag: "bot", botId: id }),
        id,
      ),
    ).toBeNull();
  });
});
