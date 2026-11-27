// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A helper that lives across many asks, written to on its stdin and read line by line, which only Node's own spawn gives as streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The Windows helper's side of the app: a program kept running between
// asks, which reads one ask per line on its stdin, `{"id":…,"ask":…}`, and
// answers each on one line of its stdout, `{"id":…,"answer":…}`.

/** One ask to the helper, as it reads it on a line, numbered by `id`. */
export const HelperAsk = Schema.Union([
  Schema.Struct({ op: Schema.Literal("front"), own: Schema.Int, title: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("picture"), window: Schema.Int }),
]);
export type HelperAsk = typeof HelperAsk.Type;
const encodeAsk = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Int, ask: HelperAsk })),
);

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Int, answer: Schema.Unknown })),
);

/**
 * A helper program, started the first time it is asked and stopped once it
 * has been idle `idleFor`, or when the scope closes. `ask` answers what the
 * helper answered, or `null` when it did not within `within`, or ended.
 */
export const residentHelper = Effect.fn("desktop.residentHelper")(function* (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly idleFor: Duration.Duration;
}) {
  const scope = yield* Effect.scope;
  const spawn = () =>
    NodeChildProcess.spawn(options.command, [...options.args], {
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  let child: ReturnType<typeof spawn> | null = null;
  let idle: Fiber.Fiber<void> | null = null;
  let next = 0;
  const waiting = new Map<number, (answer: unknown) => void>();
  /** Answers nothing to every ask still waiting: taken off first, as an answer may start the next ask. */
  const giveUp = () => {
    const given = [...waiting.values()];
    waiting.clear();
    for (const resume of given) resume(null);
  };
  const stop = Effect.sync(() => {
    child?.kill();
    child = null;
    giveUp();
  });
  yield* Effect.addFinalizer(() => stop);

  const running = () => {
    if (child !== null) return child;
    const started = spawn();
    child = started;
    const ended = () => {
      if (child !== started) return;
      child = null;
      giveUp();
    };
    started.on("error", ended);
    started.on("exit", ended);
    started.stdin.on("error", ended);
    NodeReadline.createInterface({ input: started.stdout }).on("line", (line) => {
      const answer = decodeAnswer(line);
      if (Option.isNone(answer)) return;
      const resume = waiting.get(answer.value.id);
      waiting.delete(answer.value.id);
      resume?.(answer.value.answer);
    });
    return started;
  };

  return Effect.fn("desktop.residentHelper.ask")(function* (
    ask: HelperAsk,
    within: Duration.Duration,
  ) {
    // Each ask puts off the stop.
    if (idle !== null) yield* Fiber.interrupt(idle);
    idle = yield* Effect.sleep(options.idleFor).pipe(Effect.andThen(stop), Effect.forkIn(scope));
    const answer = yield* Effect.callback<unknown>((resume) => {
      const helper = running();
      next += 1;
      const id = next;
      waiting.set(id, (value) => resume(Effect.succeed(value)));
      helper.stdin.write(`${encodeAsk({ id, ask })}\n`);
      return Effect.sync(() => waiting.delete(id));
    }).pipe(Effect.timeoutOption(within));
    return Option.getOrNull(answer);
  });
});
