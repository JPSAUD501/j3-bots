// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";

/**
 * Completes once this process's stdin reaches its end: the process that
 * started it closed its end, or exited, which closes it too. What arrives
 * before is read and dropped. A read error counts as the end, since nothing
 * more can arrive. Interrupted, it stops reading, so stdin no longer keeps
 * the process alive.
 */
export const ended = Effect.callback<void>((resume) => {
  const stdin = process.stdin;
  const done = () => resume(Effect.void);
  const drop = () => {};
  stdin.on("data", drop);
  stdin.once("end", done);
  stdin.once("close", done);
  stdin.once("error", done);
  return Effect.sync(() => {
    stdin.off("data", drop);
    stdin.off("end", done);
    stdin.off("close", done);
    stdin.off("error", done);
    stdin.pause();
  });
});
