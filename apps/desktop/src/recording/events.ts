// SPDX-License-Identifier: AGPL-3.0-or-later
import { type KeyDown, meaningOf, type System } from "./keys.ts";
import { locate, type RecordedScreen } from "./screens.ts";

// What a recording's `events.jsonl` says, one event per line, from what the
// input hook and the window reader report. Typed characters are grouped
// into runs, not one event per key; a key typed while the system says a
// password is being typed is never kept, only that one was. Every time is
// the recording's own, in milliseconds since it started with paused time
// left out, which is the time of the videos too.

/** What the recording is told, as it happens. */
export type RawInput =
  | { readonly kind: "key"; readonly at: number; readonly key: KeyDown }
  /** A mouse button pressed, `clicks` counting a double click as 2. */
  | {
      readonly kind: "press";
      readonly at: number;
      readonly button: number;
      readonly clicks: number;
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: "wheel";
      readonly at: number;
      readonly point: { readonly x: number; readonly y: number };
      readonly vertical: boolean;
      /** Positive toward the operator (down) or right, as the system reports it. */
      readonly rotation: number;
    }
  /** The window in front changed. */
  | {
      readonly kind: "window";
      readonly at: number;
      readonly app: string | null;
      readonly title: string | null;
    }
  /** Whether the system says a password is being typed, as read at `at`. */
  | { readonly kind: "secure"; readonly at: number; readonly on: boolean }
  | { readonly kind: "pause"; readonly at: number }
  | { readonly kind: "resume"; readonly at: number };

interface Placed {
  readonly screen: number;
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

/** One line of `events.jsonl`. */
export type EventLine =
  | { readonly t: number; readonly type: "start" }
  | { readonly t: number; readonly type: "text"; readonly until: number; readonly text: string }
  | { readonly t: number; readonly type: "password"; readonly until: number }
  | { readonly t: number; readonly type: "key"; readonly key: string }
  | { readonly t: number; readonly type: "shortcut"; readonly keys: string }
  | ({
      readonly t: number;
      readonly type: "click";
      readonly button: string;
      readonly clicks: number;
      readonly frame: string;
    } & Placed)
  | ({
      readonly t: number;
      readonly type: "scroll";
      readonly until: number;
      readonly direction: "up" | "down" | "left" | "right";
      readonly steps: number;
    } & Placed)
  | {
      readonly t: number;
      readonly type: "window";
      readonly app: string | null;
      readonly title: string | null;
      readonly frame: string;
    }
  | { readonly t: number; readonly type: "pause" }
  | { readonly t: number; readonly type: "resume" }
  | { readonly t: number; readonly type: "stop" };

/** A picture of a screen the recording wants, named as the event that refers to it says. */
export interface FrameWanted {
  readonly screen: number;
  readonly name: string;
}

export interface Output {
  readonly lines: ReadonlyArray<EventLine>;
  readonly frames: ReadonlyArray<FrameWanted>;
}

/** A new typed run starts after this long without a key, so its time stays true. */
const RUN_GAP = 2000;
/** Wheel turns this close together in one direction are one scroll. */
const SCROLL_GAP = 1000;
/** A click this soon after a picture of its screen refers to that picture. */
const FRAME_REUSE = 400;

const BUTTONS: Readonly<Record<number, string>> = {
  1: "left",
  2: "right",
  3: "middle",
  4: "back",
  5: "forward",
};

/** Lines of `events.jsonl`, each ending with its newline. */
export const linesText = (lines: ReadonlyArray<EventLine>) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

export const frameName = (t: number, screen: number) =>
  `frames/${String(Math.max(0, Math.floor(t))).padStart(9, "0")}-s${screen}.jpg`;

type Run =
  | { readonly kind: "text"; readonly t: number; readonly until: number; readonly text: string }
  | { readonly kind: "password"; readonly t: number; readonly until: number };

type Scroll = Extract<EventLine, { readonly type: "scroll" }>;

/**
 * Turns what a recording is told into its events. With `secureSignal`, the
 * system can say when a password is typed: then each key waits for the
 * first reading of that signal taken after it, and is kept as a password's
 * when the reading before it or that one says so. Everything after a key
 * that waits waits with it, so the events keep their order.
 */
export const makeEvents = (options: {
  readonly screens: ReadonlyArray<RecordedScreen>;
  readonly system: System;
  readonly secureSignal: boolean;
}) => {
  let secureSignal = options.secureSignal;
  /** The signal stopped answering: nothing typed since can be told from a password. */
  let blind = false;
  let paused = false;
  let run: Run | null = null;
  let scroll: Scroll | null = null;
  /** The screen the pointer was last seen on, for a picture at a window change. */
  let pointerScreen = options.screens[0]?.screen ?? 1;
  let lastWindow: { readonly app: string | null; readonly title: string | null } | null = null;
  const lastFrame = new Map<number, { readonly at: number; readonly name: string }>();
  /** Readings of the password signal, oldest first; those no waiting key needs are dropped. */
  let readings: Array<{ readonly at: number; readonly on: boolean }> = [];
  /** Inputs that wait behind a key the signal has not read past yet. */
  const waiting: Array<Exclude<RawInput, { readonly kind: "secure" }>> = [];

  const closeRun = (lines: Array<EventLine>) => {
    if (run === null) return;
    if (run.kind === "password") {
      lines.push({ t: run.t, type: "password", until: run.until });
    } else if (run.text.length > 0) {
      lines.push({ t: run.t, type: "text", until: run.until, text: run.text });
    }
    run = null;
  };
  const closeScroll = (lines: Array<EventLine>) => {
    if (scroll !== null) lines.push(scroll);
    scroll = null;
  };
  const closeAll = (lines: Array<EventLine>) => {
    closeRun(lines);
    closeScroll(lines);
  };

  /** A picture of `screen` at `at`: the one just taken, when there is one. */
  const frame = (at: number, screen: number, frames: Array<FrameWanted>) => {
    const last = lastFrame.get(screen);
    if (last !== undefined && at - last.at < FRAME_REUSE) return last.name;
    const name = frameName(at, screen);
    lastFrame.set(screen, { at, name });
    frames.push({ screen, name });
    return name;
  };

  const typeKey = (at: number, key: KeyDown, secure: boolean, lines: Array<EventLine>) => {
    const meaning = meaningOf(key, options.system);
    closeScroll(lines);
    switch (meaning._tag) {
      case "none":
        return;
      case "char": {
        if (secure) {
          if (run?.kind !== "password") closeRun(lines);
          run = { kind: "password", t: run?.kind === "password" ? run.t : at, until: at };
          return;
        }
        if (run?.kind !== "text" || at - run.until > RUN_GAP) closeRun(lines);
        run =
          run?.kind === "text"
            ? { ...run, until: at, text: run.text + meaning.char }
            : { kind: "text", t: at, until: at, text: meaning.char };
        return;
      }
      case "named": {
        if (meaning.name === "Backspace") {
          if (run?.kind === "password" && secure) {
            run = { ...run, until: at };
            return;
          }
          if (run?.kind === "text" && run.text.length > 0) {
            run = { ...run, until: at, text: Array.from(run.text).slice(0, -1).join("") };
            return;
          }
        }
        closeRun(lines);
        lines.push({ t: at, type: "key", key: meaning.name });
        return;
      }
      case "shortcut":
        closeRun(lines);
        lines.push({ t: at, type: "shortcut", keys: meaning.keys });
        return;
    }
  };

  const apply = (
    input: Exclude<RawInput, { readonly kind: "secure" }>,
    secure: boolean,
    lines: Array<EventLine>,
    frames: Array<FrameWanted>,
  ) => {
    if (input.kind === "pause") {
      if (paused) return;
      closeAll(lines);
      paused = true;
      lines.push({ t: input.at, type: "pause" });
      return;
    }
    if (input.kind === "resume") {
      if (!paused) return;
      paused = false;
      lines.push({ t: input.at, type: "resume" });
      return;
    }
    // Pause is how the operator hides something: nothing is kept meanwhile.
    if (paused) return;
    switch (input.kind) {
      case "key":
        typeKey(input.at, input.key, secure, lines);
        return;
      case "press": {
        const place = locate(input.point, options.screens);
        if (place === null) return;
        closeAll(lines);
        pointerScreen = place.screen;
        lines.push({
          t: input.at,
          type: "click",
          button: BUTTONS[input.button] ?? `button-${input.button}`,
          clicks: Math.max(1, input.clicks),
          ...place,
          frame: frame(input.at, place.screen, frames),
        });
        return;
      }
      case "wheel": {
        const place = locate(input.point, options.screens);
        if (place === null || input.rotation === 0) return;
        closeRun(lines);
        pointerScreen = place.screen;
        const direction = input.vertical
          ? input.rotation > 0
            ? "down"
            : "up"
          : input.rotation > 0
            ? "right"
            : "left";
        const steps = Math.abs(input.rotation);
        if (
          scroll !== null &&
          scroll.direction === direction &&
          scroll.screen === place.screen &&
          input.at - scroll.until <= SCROLL_GAP
        ) {
          scroll = { ...scroll, until: input.at, steps: scroll.steps + steps };
          return;
        }
        closeScroll(lines);
        scroll = { t: input.at, type: "scroll", until: input.at, direction, steps, ...place };
        return;
      }
      case "window": {
        if (
          lastWindow !== null &&
          lastWindow.app === input.app &&
          lastWindow.title === input.title
        ) {
          return;
        }
        lastWindow = { app: input.app, title: input.title };
        closeAll(lines);
        lines.push({
          t: input.at,
          type: "window",
          app: input.app,
          title: input.title,
          frame: frame(input.at, pointerScreen, frames),
        });
        return;
      }
    }
  };

  /** Whether the password signal says so at the last reading before `at`, or the first after it; `null` while that one is to come. */
  const secureAt = (at: number, final: boolean): boolean | null => {
    let before: boolean | null = null;
    for (const reading of readings) {
      if (reading.at <= at) before = reading.on;
      if (reading.at >= at) return before === true || reading.on;
    }
    return final || !secureSignal ? before === true : null;
  };

  const drain = (final: boolean): Output => {
    const lines: Array<EventLine> = [];
    const frames: Array<FrameWanted> = [];
    while (waiting.length > 0) {
      const input = waiting[0]!;
      let secure = false;
      if (input.kind === "key" && secureSignal) {
        const known = secureAt(input.at, final);
        if (known === null) break;
        secure = known;
      } else if (input.kind === "key") {
        secure = blind || secureAt(input.at, true) === true;
      }
      waiting.shift();
      apply(input, secure, lines, frames);
    }
    // Keep the last reading before the first key still waiting, and every one after.
    const first = waiting.find((input) => input.kind === "key")?.at ?? Number.POSITIVE_INFINITY;
    const lastBefore = readings.findLastIndex((reading) => reading.at <= first);
    if (lastBefore > 0) readings = readings.slice(lastBefore);
    return { lines, frames };
  };

  return {
    push: (input: RawInput): Output => {
      if (input.kind === "secure") readings.push({ at: input.at, on: input.on });
      else waiting.push(input);
      return drain(false);
    },
    /**
     * The signal stopped answering: keys waiting go by its last reading, and
     * every character typed from now on is kept as a password's, since
     * nothing can tell it is not one.
     */
    signalLost: (): Output => {
      const output = drain(true);
      secureSignal = false;
      blind = true;
      return output;
    },
    /** The recording stopped at `at`: what waits goes by the last reading, and every run ends. */
    finish: (at: number): Output => {
      const { lines, frames } = drain(true);
      const all = [...lines];
      closeAll(all);
      all.push({ t: at, type: "stop" });
      return { lines: all, frames };
    },
  };
};
