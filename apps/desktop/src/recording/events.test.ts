// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type EventLine, makeEvents, type RawInput } from "./events.ts";
import type { KeyDown } from "./keys.ts";
import { locate, type RecordedScreen, videoSize } from "./screens.ts";

/** Two screens side by side: a 2560×1440 one, and a 1920×1080 one to its right, lower. */
const SCREENS: ReadonlyArray<RecordedScreen> = [
  {
    screen: 1,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    video: videoSize({ width: 2560, height: 1440 }),
  },
  {
    screen: 2,
    bounds: { x: 2560, y: 360, width: 1920, height: 1080 },
    video: videoSize({ width: 1920, height: 1080 }),
  },
];

const CODES: Readonly<Record<string, number>> = {
  h: 0x23,
  i: 0x17,
  x: 0x2d,
  " ": 0x39,
  "1": 0x02,
  c: 0x2e,
  Enter: 0x1c,
  Backspace: 0x0e,
  Tab: 0x0f,
};

const key = (name: string, held: Partial<Omit<KeyDown, "code">> = {}): KeyDown => ({
  code: CODES[name]!,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...held,
});

const typing = (from: number, text: string): ReadonlyArray<RawInput> =>
  Array.from(text, (char, at) => ({ kind: "key", at: from + at * 100, key: key(char) }));

const run = (
  inputs: ReadonlyArray<RawInput>,
  options: { readonly secureSignal?: boolean; readonly stopAt?: number } = {},
) => {
  const events = makeEvents({
    screens: SCREENS,
    system: "linux",
    secureSignal: options.secureSignal ?? false,
  });
  const lines: Array<EventLine> = [];
  for (const input of inputs) lines.push(...events.push(input).lines);
  lines.push(...events.finish(options.stopAt ?? 99_000).lines);
  return lines;
};

describe("a recording's screens", () => {
  it("records each screen within HD, its shape kept and its sides even", () => {
    assert.deepStrictEqual(videoSize({ width: 2560, height: 1440 }), { width: 1280, height: 720 });
    assert.deepStrictEqual(videoSize({ width: 1920, height: 1200 }), { width: 1152, height: 720 });
    assert.deepStrictEqual(videoSize({ width: 1080, height: 1920 }), { width: 720, height: 1280 });
    assert.deepStrictEqual(videoSize({ width: 1024, height: 768 }), { width: 960, height: 720 });
    assert.deepStrictEqual(videoSize({ width: 1001, height: 501 }), { width: 1002, height: 502 });
  });

  it("puts a point in the video of the screen it is on, in that video's pixels", () => {
    assert.deepStrictEqual(locate({ x: 1280, y: 720 }, SCREENS), {
      screen: 1,
      x: 640,
      y: 360,
      nx: 0.5,
      ny: 0.5,
    });
    assert.deepStrictEqual(locate({ x: 2560 + 480, y: 360 + 810 }, SCREENS), {
      screen: 2,
      x: 320,
      y: 540,
      nx: 0.25,
      ny: 0.75,
    });
  });

  it("puts a point between screens at the edge of the nearest", () => {
    // Below both screens, 60 px under screen 2 and 72 px from screen 1's corner.
    assert.deepStrictEqual(locate({ x: 2600, y: 1500 }, SCREENS), {
      screen: 2,
      x: 27,
      y: 719,
      nx: 0.0208,
      ny: 1,
    });
  });
});

describe("a recording's events", () => {
  it("groups typed characters into a run, with Backspace applied", () => {
    const lines = run([
      ...typing(1000, "hix"),
      { kind: "key", at: 1300, key: key("Backspace") },
      ...typing(1400, " 1"),
      { kind: "key", at: 1600, key: key("1", { shift: true }) },
      { kind: "key", at: 1700, key: key("Enter") },
    ]);
    assert.deepStrictEqual(lines.slice(0, 2), [
      { t: 1000, type: "text", until: 1600, text: "hi 1!" },
      { t: 1700, type: "key", key: "Enter" },
    ]);
  });

  it("starts a new run after a pause in typing, so each keeps its own time", () => {
    const lines = run([...typing(1000, "hi"), ...typing(5000, "x")]);
    assert.deepStrictEqual(lines.slice(0, 2), [
      { t: 1000, type: "text", until: 1100, text: "hi" },
      { t: 5000, type: "text", until: 5000, text: "x" },
    ]);
  });

  it("keeps a shortcut as the keys held, and a Backspace with nothing typed as a key", () => {
    const lines = run([
      { kind: "key", at: 1000, key: key("c", { ctrl: true }) },
      { kind: "key", at: 1100, key: key("Tab", { shift: true }) },
      { kind: "key", at: 1200, key: key("Backspace") },
    ]);
    assert.deepStrictEqual(lines.slice(0, 3), [
      { t: 1000, type: "shortcut", keys: "Ctrl+C" },
      { t: 1100, type: "key", key: "Shift+Tab" },
      { t: 1200, type: "key", key: "Backspace" },
    ]);
  });

  it("ends a run at a click, and pictures the click's screen, once for a double click", () => {
    const events = makeEvents({ screens: SCREENS, system: "linux", secureSignal: false });
    const typed = typing(1000, "hi").map((input) => events.push(input));
    assert.deepStrictEqual(
      typed.flatMap((output) => output.lines),
      [],
    );
    const first = events.push({
      kind: "press",
      at: 2000,
      button: 1,
      clicks: 1,
      point: { x: 2560 + 960, y: 360 + 540 },
    });
    const second = events.push({
      kind: "press",
      at: 2200,
      button: 1,
      clicks: 2,
      point: { x: 2560 + 960, y: 360 + 540 },
    });
    assert.deepStrictEqual(first.lines, [
      { t: 1000, type: "text", until: 1100, text: "hi" },
      {
        t: 2000,
        type: "click",
        button: "left",
        clicks: 1,
        screen: 2,
        x: 640,
        y: 360,
        nx: 0.5,
        ny: 0.5,
        frame: "frames/000002000-s2.jpg",
      },
    ]);
    assert.deepStrictEqual(first.frames, [{ screen: 2, name: "frames/000002000-s2.jpg" }]);
    assert.strictEqual(
      second.lines[0]?.type === "click" ? second.lines[0].frame : null,
      "frames/000002000-s2.jpg",
    );
    assert.deepStrictEqual(second.frames, []);
  });

  it("joins wheel turns in one direction into one scroll", () => {
    const at = (t: number, rotation: number): RawInput => ({
      kind: "wheel",
      at: t,
      point: { x: 100, y: 100 },
      vertical: true,
      rotation,
    });
    const lines = run([at(1000, 1), at(1200, 2), at(1400, 1), at(1500, -1)]);
    assert.deepStrictEqual(
      lines
        .slice(0, 2)
        .map((line) =>
          line.type === "scroll" ? [line.t, line.until, line.direction, line.steps] : line.type,
        ),
      [
        [1000, 1400, "down", 4],
        [1500, 1500, "up", 1],
      ],
    );
  });

  it("keeps nothing while paused, and the window in front when it changes", () => {
    const lines = run([
      { kind: "window", at: 0, app: "Files", title: "Reports" },
      { kind: "pause", at: 500 },
      ...typing(600, "hi"),
      { kind: "window", at: 700, app: "Mail", title: "Inbox" },
      { kind: "resume", at: 500 },
      { kind: "window", at: 800, app: "Files", title: "Reports" },
      { kind: "window", at: 900, app: "Mail", title: "Inbox" },
    ]);
    assert.deepStrictEqual(
      lines.map((line) =>
        line.type === "window" ? `${line.t} ${line.app}` : `${line.t} ${line.type}`,
      ),
      ["0 Files", "500 pause", "500 resume", "900 Mail", "99000 stop"],
    );
  });

  it("keeps a password as typed, never its characters, by the signal's reading before or after each key", () => {
    const lines = run(
      [
        { kind: "secure", at: 0, on: false },
        ...typing(50, "hi"),
        { kind: "secure", at: 200, on: false },
        // A password field took focus somewhere between two readings: what
        // was typed between them is hidden too.
        ...typing(250, "x1"),
        { kind: "secure", at: 400, on: true },
        { kind: "key", at: 450, key: key("Backspace") },
        ...typing(500, "ch"),
        { kind: "secure", at: 600, on: true },
        { kind: "key", at: 650, key: key("Enter") },
        { kind: "secure", at: 800, on: false },
        ...typing(850, "hi"),
        { kind: "secure", at: 1000, on: false },
      ],
      { secureSignal: true },
    );
    assert.deepStrictEqual(lines, [
      { t: 50, type: "text", until: 150, text: "hi" },
      { t: 250, type: "password", until: 600 },
      { t: 650, type: "key", key: "Enter" },
      { t: 850, type: "text", until: 950, text: "hi" },
      { t: 99_000, type: "stop" },
    ]);
  });

  it("holds every event behind a key until the signal reads past it, so the order stays", () => {
    const events = makeEvents({ screens: SCREENS, system: "linux", secureSignal: true });
    events.push({ kind: "secure", at: 0, on: false });
    assert.deepStrictEqual(events.push({ kind: "key", at: 100, key: key("h") }).lines, []);
    assert.deepStrictEqual(
      events.push({ kind: "press", at: 150, button: 3, clicks: 1, point: { x: 0, y: 0 } }).lines,
      [],
    );
    const released = events.push({ kind: "secure", at: 200, on: false });
    assert.deepStrictEqual(
      released.lines.map((line) => line.type),
      ["text", "click"],
    );
  });

  it("hides every character no reading covers once the signal stops answering", () => {
    const events = makeEvents({ screens: SCREENS, system: "mac", secureSignal: true });
    const lines: Array<EventLine> = [];
    events.push({ kind: "secure", at: 0, on: false });
    for (const input of typing(100, "hi")) lines.push(...events.push(input).lines);
    lines.push(...events.push({ kind: "secure", at: 300, on: false }).lines);
    // Typed after the last reading, then the signal stops: nothing read them.
    for (const input of typing(400, "x1")) lines.push(...events.push(input).lines);
    lines.push(...events.signalLost().lines);
    for (const input of typing(700, "hi")) lines.push(...events.push(input).lines);
    lines.push(...events.finish(900).lines);
    assert.deepStrictEqual(lines, [
      { t: 100, type: "text", until: 200, text: "hi" },
      { t: 400, type: "password", until: 800 },
      { t: 900, type: "stop" },
    ]);
  });

  it("keeps a key held with Option or AltGr in a password as typed, since it can type a character", () => {
    const events = makeEvents({ screens: SCREENS, system: "mac", secureSignal: true });
    const lines: Array<EventLine> = [];
    for (const input of [
      { kind: "secure", at: 0, on: true },
      { kind: "key", at: 100, key: key("x", { alt: true }) },
      { kind: "key", at: 200, key: key("1", { ctrl: true, alt: true }) },
      { kind: "secure", at: 300, on: true },
    ] satisfies ReadonlyArray<RawInput>)
      lines.push(...events.push(input).lines);
    lines.push(...events.finish(400).lines);
    assert.deepStrictEqual(lines, [
      { t: 100, type: "password", until: 200 },
      { t: 400, type: "stop" },
    ]);
  });

  it("goes by the last reading for keys still waiting when the recording stops", () => {
    const lines = run([{ kind: "secure", at: 0, on: true }, ...typing(100, "hi")], {
      secureSignal: true,
      stopAt: 300,
    });
    assert.deepStrictEqual(lines, [
      { t: 100, type: "password", until: 200 },
      { t: 300, type: "stop" },
    ]);
  });
});
