// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Base64 from "effect/encoding/Base64";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// The Android app of the every-surface check, driven with agent-device and
// adb. Both run in a shell where they reach the emulator: this machine's, or
// another's through a command that runs one shell line there (`ssh host`, say),
// since the emulator may live on another machine than the desktop app.

/** The development build's application id. */
const APP_ID = "dev.j3bots.mobile.dev";
/** The emulator adb names first. */
const SERIAL = "emulator-5554";

class PhoneFailed extends Schema.TaggedError<PhoneFailed>()("PhoneFailed", {
  line: Schema.String,
  output: Schema.String,
}) {
  override get message(): string {
    return `The phone's shell failed running ${this.line}:\n${this.output}`;
  }
}

/** A node of agent-device's snapshot, as far as the check reads it. */
const Rect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const SnapshotNode = Schema.Struct({
  kind: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  rect: Schema.optional(Rect),
});
type SnapshotNode = typeof SnapshotNode.Type;
const Snapshot = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({ nodes: Schema.Array(SnapshotNode) }),
});
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));

/** One shell argument, quoted for `sh`. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const words = (parts: ReadonlyArray<string>) => parts.map(quote).join(" ");

/** An agent-device selector for the element whose label is `label`, of `role` when given. */
export const labelled = (label: string, role?: "button" | "text-field") =>
  role === "text-field"
    ? `label=${JSON.stringify(label)} editable=true`
    : role === "button"
      ? `role=button label=${JSON.stringify(label)}`
      : `label=${JSON.stringify(label)}`;

/**
 * Where to tap to close React Native's collapsed warnings, if the screen shows
 * them: a development build stacks its warnings in one bar over the bottom of
 * the screen, where the composer is, labelled "<count>, <the first warning>",
 * with the count as a text of its own and a close button, which has no label,
 * at its end. Closing it dismisses them all.
 */
const warningsClose = (
  nodes: ReadonlyArray<SnapshotNode>,
): Option.Option<{ readonly x: number; readonly y: number }> => {
  const at = nodes.findIndex((node, index) => {
    const count = /^(\d+), ./.exec(node.label ?? "")?.[1];
    return node.kind === "group" && count !== undefined && nodes[index + 1]?.label === count;
  });
  const bar = nodes[at]?.rect;
  if (bar === undefined) return Option.none();
  const close = nodes
    .slice(at + 1)
    .find(
      ({ label, rect }) =>
        label === undefined &&
        rect !== undefined &&
        rect.x > bar.x + bar.width * 0.8 &&
        rect.y >= bar.y &&
        rect.y + rect.height <= bar.y + bar.height,
    )?.rect;
  return close === undefined
    ? Option.none()
    : Option.some({
        x: Math.round(close.x + close.width / 2),
        y: Math.round(close.y + close.height / 2),
      });
};

/** Where a text the phone shows stands: every node that shows exactly it, top to bottom. */
export interface Shown {
  readonly text: string;
  readonly at: ReadonlyArray<number>;
}

/**
 * The phone, through `shell`: the program and the arguments before the one
 * shell line it runs, such as `["sh", "-c"]`.
 */
export const makePhone = (shell: readonly [string, ...Array<string>], metro: string) => {
  const run = Effect.fn("Phone.run")(function* (lines: ReadonlyArray<string>) {
    const line = lines.join(" && ");
    const [program, ...before] = shell;
    const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
      ChildProcess.make(program, [...before, line], { stdin: "ignore" }),
    );
    const [output, errors, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    if (Number(exitCode) !== 0) {
      return yield* new PhoneFailed({ line, output: `${output}${errors}`.slice(-2000) });
    }
    return output;
  }, Effect.scoped);

  const device = (...parts: ReadonlyArray<string>) => words(["agent-device", ...parts]);
  const adb = (...parts: ReadonlyArray<string>) => words(["adb", "-s", SERIAL, ...parts]);

  const snapshot = run([device("snapshot", "--json")]).pipe(
    Effect.flatMap(decodeSnapshot),
    Effect.map((snapshot) => snapshot.data.nodes),
  );

  // agent-device's own dismiss-overlay does not recognise the collapsed bar.
  const clearWarnings = snapshot.pipe(
    Effect.map(warningsClose),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ x, y }) =>
          run([device("press", String(x), String(y))]).pipe(Effect.andThen(Effect.fail("shown"))),
      }),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
    Effect.catchIf(
      (error): error is "shown" => error === "shown",
      () => Effect.die("React Native's warnings still cover the app after five closes"),
    ),
  );

  /** Whether the phone shows any of `labels` now. */
  const showsAny = (labels: ReadonlyArray<string>) =>
    snapshot.pipe(
      Effect.map((nodes) => labels.filter((label) => nodes.some((node) => node.label === label))),
    );

  return {
    run,
    /**
     * The app as new: its data cleared, then opened on Metro's bundle, past the
     * development menu, on the pairing screen. Metro is reached on the phone's
     * own loopback (`adb reverse`), so the phone's airplane mode leaves it.
     */
    openFresh: Effect.gen(function* () {
      const link = `j3bots-dev://expo-development-client/?url=${encodeURIComponent(metro)}`;
      yield* run([
        adb("shell", "pm", "clear", APP_ID),
        device("open", APP_ID, link, "--platform", "android"),
      ]);
      // A cleared development build shows its menu's introduction, then the menu.
      yield* showsAny(["Server address", "Continue", "Reload"]).pipe(
        Effect.flatMap(([first]) =>
          first === "Server address"
            ? Effect.void
            : first === "Continue"
              ? run([device("press", labelled("Continue"))]).pipe(
                  Effect.andThen(Effect.fail("menu")),
                )
              : first === "Reload"
                ? run([device("press", labelled("Close"))]).pipe(
                    Effect.andThen(Effect.fail("menu")),
                  )
                : Effect.fail("loading"),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
        Effect.orDie,
      );
    }),
    fill: (selector: string, text: string) =>
      clearWarnings.pipe(Effect.andThen(run([device("fill", selector, text)]))),
    press: (selector: string) =>
      clearWarnings.pipe(Effect.andThen(run([device("press", selector)]))),
    /** Writes `text` into the composer labelled `composer` and sends it. */
    send: (composer: string, text: string) =>
      clearWarnings.pipe(
        Effect.andThen(
          run([
            device("fill", labelled(composer, "text-field"), text),
            device("press", labelled("Send message", "button")),
          ]),
        ),
      ),
    waitText: (text: string, timeoutMs = 30_000) =>
      run([device("wait", "text", text, String(timeoutMs))]),
    waitAbsent: (selector: string, timeoutMs = 30_000) =>
      run([device("wait", "absent", selector, String(timeoutMs))]),
    /** Each of `texts` as the phone shows it, by text nodes that show exactly it. */
    shown: (texts: ReadonlyArray<string>) =>
      snapshot.pipe(
        Effect.map((nodes) =>
          texts.map((text): Shown => ({
            text,
            at: nodes
              .filter((node) => node.kind === "text" && node.label === text)
              .map((node) => node.rect?.y ?? 0)
              .sort((a, b) => a - b),
          })),
        ),
      ),
    /** The phone's connection: airplane mode on cuts it, off restores it. */
    airplane: (on: boolean) =>
      run([adb("shell", "cmd", "connectivity", "airplane-mode", on ? "enable" : "disable")]),
    /** A screenshot of the phone, written to `file` here. */
    screenshot: Effect.fn("Phone.screenshot")(function* (file: string) {
      const shot = "/tmp/j3-every-surface-phone.png";
      const encoded = yield* run([
        `${device("screenshot", shot)} > /dev/null`,
        words(["base64", "-w0", shot]),
      ]);
      const bytes = Base64.decode(encoded.trim());
      if (Result.isFailure(bytes))
        return yield* Effect.die("The phone's screenshot did not decode");
      yield* (yield* FileSystem.FileSystem).writeFile(file, bytes.success);
    }),
    /** Whether the phone shows `label` now. */
    shows: (label: string) =>
      showsAny([label]).pipe(Effect.map((found) => Option.isSome(Option.fromNullishOr(found[0])))),
  };
};

export type Phone = ReturnType<typeof makePhone>;
