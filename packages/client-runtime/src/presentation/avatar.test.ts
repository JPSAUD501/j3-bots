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
  avatarBusy,
  avatarNearness,
  createAvatar,
  notificationState,
  plainTraits,
  pointerNear,
  pokeAvatar,
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
  typing: false,
  retrying: false,
  activity: null,
  tool: null,
  littleOnes: 0,
};
const quiet = { unread: false, speaking: false, offline: false };

describe("avatarMood", () => {
  it("shows a turn under way as thinking or working, and an idle bot as idle", () => {
    expect(avatarMood({ _tag: "idle" }, quiet)).toEqual({ state: "idle", stalled: false });
    expect(
      avatarMood(
        {
          _tag: "thinking",
          since,
          stalled: false,
          quietSince: null,
          typing: false,
          retrying: false,
        },
        quiet,
      ).state,
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
      avatarMood(
        {
          _tag: "thinking",
          since,
          stalled: true,
          quietSince: since,
          typing: false,
          retrying: false,
        },
        quiet,
      ).stalled,
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

  it("shows a message as unread, even while the turn goes on", () => {
    expect(notificationState({ kind: "message" }, working)).toBe("unread");
    expect(notificationState({ kind: "message" }, { _tag: "idle" })).toBe("unread");
  });

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

/** `sim` stepped at `rate` frames a second for `seconds`. */
const run = (sim: AvatarSim, seconds: number, rate = 60) => {
  let next = sim;
  for (let i = 0; i < Math.round(seconds * rate); i++) next = stepAvatar(next, 1 / rate, null);
  return next;
};

/** The highest `sim` rises off the ground over `seconds`, in the avatar's units. */
const highest = (
  sim: AvatarSim,
  seconds: number,
  each?: (sim: AvatarSim, frame: number) => AvatarSim,
) => {
  let next = sim;
  let top = 0;
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
    next = stepAvatar(each?.(next, frame) ?? next, 1 / 60, null);
    top = Math.max(top, -next.hop.x);
  }
  return { top, sim: next };
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

const seed = avatarSeed("bot-1");

describe("a change of state", () => {
  it("eases into the new pose within a second", () => {
    const sim = run(setAvatarState(createAvatar(seed, "idle"), "working"), 1.2);
    const face = avatarFace(sim);
    const pose = stillFace("working");
    expect(face.lidTop).toBeCloseTo(pose.lidTop, 2);
    expect(face.pupil).toBeCloseTo(pose.pupil, 2);
  });

  it("moves the body once, its own way: a hop up for waiting, a slump for blocked", () => {
    const idle = createAvatar(seed, "idle");
    expect(highest(setAvatarState(idle, "waiting"), 0.5).top).toBeGreaterThan(4);
    const blocked = run(setAvatarState(idle, "blocked"), 0.2);
    expect(blocked.hop.x).toBeGreaterThan(1);
    expect(blocked.air).toBe(false);
    expect(setAvatarState(idle, "idle")).toBe(idle);
  });

  it("comes to rest afterwards", () => {
    const sim = run(setAvatarState(createAvatar(seed, "idle"), "blocked"), 4);
    expect(Math.abs(sim.hop.x)).toBeLessThan(0.5);
    expect(Math.abs(sim.lagX.x)).toBeLessThan(0.5);
  });
});

describe("the pointer", () => {
  const { full, none } = avatarNearness;

  it("has an avatar's eye only within a close radius of it", () => {
    expect(pointerNear(none * 40 + 1, 0, 40)).toBeNull();
    expect(pointerNear(0, 400, 96)).toBeNull();
    expect(pointerNear(full * 40 - 1, 0, 40)?.attention).toBe(1);
    expect(pointerNear(30, 30, 96)?.attention).toBe(1);
  });

  it("eases in at the edge of that radius, never all at once", () => {
    const at = (widths: number) => pointerNear(widths * 96, 0, 96)?.attention ?? 0;
    const edge = [2.95, 2.75, 2.5, 2.25, 2.05].map(at);
    expect(edge[0]).toBeLessThan(0.02);
    expect(edge.at(-1)).toBeGreaterThan(0.98);
    for (let i = 1; i < edge.length; i++) expect(edge[i]).toBeGreaterThan(edge[i - 1] ?? 1);
  });

  it("turns the eye toward it, and straight out when it is right over the avatar", () => {
    const right = pointerNear(120, 0, 96);
    expect(right?.x).toBeCloseTo(1, 6);
    expect(right?.y).toBeCloseTo(0, 6);
    expect(pointerNear(0, 0, 96)).toMatchObject({ x: 0, y: 0, closeness: 1 });
  });

  it("leads the eye of a bot that looks out, and not of one at work", () => {
    const near = pointerNear(100, 0, 96);
    const follow = (state: AvatarState) => {
      let sim = createAvatar(seed, state);
      for (let i = 0; i < 90; i++) sim = stepAvatar(sim, 1 / 60, near);
      return avatarFace(sim).gazeX;
    };
    expect(follow("idle")).toBeGreaterThan(0.9);
    expect(follow("working")).toBeLessThan(0.7);
  });

  it("lets the eye go gently once it is out of reach", () => {
    let sim = createAvatar(seed, "waiting");
    for (let i = 0; i < 90; i++) sim = stepAvatar(sim, 1 / 60, pointerNear(100, 0, 96));
    const held = avatarFace(sim).gazeX;
    const after = avatarFace(stepAvatar(sim, 1 / 60, null)).gazeX;
    expect(held - after).toBeLessThan(0.08);
    expect(avatarFace(run(sim, 1.5)).gazeX).toBeCloseTo(0, 1);
  });
});

describe("a press and a tap", () => {
  const idle = () => run(createAvatar(seed, "idle"), 0.5);

  it("holds the body down while pressed, and lets it up when let go", () => {
    const pressed = run(pokeAvatar(idle(), "press"), 0.5);
    expect(pressed.hop.x).toBeGreaterThan(4);
    expect(avatarFace(pressed).squash).toBeGreaterThan(0.05);
    const released = run(pokeAvatar(pressed, "release"), 1.5);
    expect(Math.abs(released.hop.x)).toBeLessThan(0.2);
  });

  it("answers a tap differently from the tap before", () => {
    let sim = idle();
    const acts: Array<AvatarSim["act"]> = [];
    for (let i = 0; i < 6; i++) {
      sim = pokeAvatar(pokeAvatar(sim, "press"), "tap");
      acts.push(sim.act);
      sim = run(sim, 1.4);
    }
    for (let i = 1; i < acts.length; i++) expect(acts[i]).not.toBe(acts[i - 1]);
  });

  it("does not add up: ten taps in a second rise no higher than a hop can", () => {
    const { top: once } = highest(pokeAvatar(idle(), "hop"), 1);
    const { top, sim } = highest(idle(), 1, (now, frame) =>
      frame % 6 === 0 ? pokeAvatar(pokeAvatar(now, "press"), "tap") : now,
    );
    expect(once).toBeGreaterThan(4);
    expect(top).toBeLessThan(once * 3);
    const rested = run(sim, 2.5);
    expect(Math.abs(rested.hop.x)).toBeLessThan(0.2);
    expect(Math.abs(rested.tilt.x)).toBeLessThan(3);
  });

  it("moves on from where it is: a tap mid-hop never jumps what is drawn", () => {
    let sim = pokeAvatar(idle(), "hop");
    let before = avatarFace(sim);
    for (let frame = 0; frame < 90; frame++) {
      if (frame % 7 === 3) sim = pokeAvatar(pokeAvatar(sim, "press"), "tap");
      sim = stepAvatar(sim, 1 / 60, null);
      const now = avatarFace(sim);
      // A frame moves the body no further than its fastest launch does, and reshapes it a little.
      expect(Math.abs(now.hop - before.hop)).toBeLessThan(3.5);
      expect(Math.abs(now.squash - before.squash)).toBeLessThan(0.07);
      expect(Math.abs(now.tilt - before.tilt)).toBeLessThan(1.5);
      before = now;
    }
  });
});

describe("a bot and its little ones", () => {
  const working = () => run(createAvatar(seed, "working"), 0.5);

  it("squashes down while it braces, and is let up once the last one is out", () => {
    const braced = run(pokeAvatar(working(), "brace"), 0.4);
    expect(braced.hop.x).toBeGreaterThan(5);
    expect(avatarFace(braced).squash).toBeGreaterThan(0.1);
    const popped = run(pokeAvatar(braced, "pop"), 2.5);
    expect(Math.abs(popped.hop.x)).toBeLessThan(0.2);
  });

  it("springs up off each one that comes out, and four in a row rise no higher than a hop", () => {
    const { top: once } = highest(pokeAvatar(working(), "hop"), 1);
    const { top } = highest(pokeAvatar(working(), "brace"), 1.4, (now, frame) =>
      frame >= 28 && frame < 68 && (frame - 28) % 10 === 0 ? pokeAvatar(now, "pop") : now,
    );
    expect(top).toBeGreaterThan(1);
    expect(top).toBeLessThan(once);
  });

  it("swells as it gulps one back in, and comes back to its size", () => {
    let sim = pokeAvatar(working(), "gulp");
    let most = 0;
    for (let frame = 0; frame < 30; frame++) {
      sim = stepAvatar(sim, 1 / 60, null);
      most = Math.max(most, avatarFace(sim).swell);
    }
    expect(most).toBeGreaterThan(0.04);
    expect(Math.abs(avatarFace(run(sim, 2)).swell)).toBeLessThan(0.005);
  });

  it("glows as it gulps one that did its part, and not one that failed", () => {
    const glow = (poke: "gulp" | "sulk") => {
      let sim = pokeAvatar(working(), poke);
      let most = 0;
      for (let frame = 0; frame < 30; frame++) {
        sim = stepAvatar(sim, 1 / 60, null);
        most = Math.max(most, avatarFace(sim).glow);
      }
      return most;
    };
    expect(glow("gulp")).toBeGreaterThan(0.5);
    expect(glow("sulk")).toBe(0);
  });
});

describe("an entrance", () => {
  const entering = () => pokeAvatar(createAvatar(seed, "idle"), "arrive");

  it("comes down from above, lands, and only then lights its antenna", () => {
    const start = entering();
    expect(-start.hop.x).toBeGreaterThan(100);
    const falling = run(start, 0.3);
    expect(falling.air).toBe(true);
    expect(avatarFace(falling).lightScale).toBeLessThan(0.7);
    const landed = run(start, 1.4);
    expect(landed.entering).toBe(false);
    expect(avatarFace(landed).lightScale).toBeGreaterThan(0.9);
    expect(avatarBusy(run(start, 4))).toBe(false);
  });

  it("lands with weight: it squashes as it meets the ground", () => {
    let sim = entering();
    let deepest = 0;
    for (let i = 0; i < 120; i++) {
      sim = stepAvatar(sim, 1 / 60, null);
      deepest = Math.max(deepest, avatarFace(sim).squash);
    }
    expect(deepest).toBeGreaterThan(0.12);
    expect(deepest).toBeLessThan(0.4);
  });

  it("is the same motion at any frame rate", () => {
    const smooth = run(entering(), 0.5, 120);
    const coarse = run(entering(), 0.5, 20);
    expect(coarse.hop.x).toBeCloseTo(smooth.hop.x, 3);
    expect(coarse.hop.v).toBeCloseTo(smooth.hop.v, 2);
    // Past the landing and the rebound, which fall inside a frame at one rate and on one at the other.
    const after = (rate: number) => run(entering(), 0.875, rate);
    expect(after(24).hop.x).toBeCloseTo(after(120).hop.x, 3);
  });

  it("survives a frame of any length", () => {
    const stalled = stepAvatar(pokeAvatar(pokeAvatar(entering(), "press"), "tap"), 30, null);
    const face = avatarFace(stalled);
    for (const value of [face.hop, face.squash, face.tilt, face.lagX, face.lagY, face.gazeX]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(Math.abs(face.hop)).toBeLessThan(1);
    expect(Math.abs(face.squash)).toBeLessThan(0.2);
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
