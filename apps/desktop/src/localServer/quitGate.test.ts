// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { quitGate } from "./quitGate.ts";

/** A quit request, and whether its handler held it. */
const request = () => {
  let held = false;
  return { event: { preventDefault: () => (held = true) }, held: () => held };
};

/** A gate over a server that runs while `runs`, and whose stop ends as `stop` does. */
const gate = (runs: boolean, stop: () => Promise<void>) => {
  const done: Array<string> = [];
  const handler = quitGate({
    serverRuns: () => runs,
    stopServer: () => {
      done.push("stop");
      return stop();
    },
    quit: () => done.push("quit"),
  });
  return { handler, done };
};

describe("holding the app's quit while its server stops", () => {
  it("lets the quit through at once when no server runs", () => {
    const { handler, done } = gate(false, () => Promise.resolve());
    const quit = request();
    handler(quit.event);
    assert.isFalse(quit.held());
    assert.deepStrictEqual(done, []);
  });

  it("holds the quit, stops the server, then quits, letting that quit through", async () => {
    let stopped = (): void => undefined;
    const { handler, done } = gate(true, () => new Promise<void>((resolve) => (stopped = resolve)));
    const first = request();
    handler(first.event);
    assert.isTrue(first.held());
    assert.deepStrictEqual(done, ["stop"]);

    // Quit asked again while the server stops (the tray, then the system): held, not stopped twice.
    const again = request();
    handler(again.event);
    assert.isTrue(again.held());
    assert.deepStrictEqual(done, ["stop"]);

    stopped();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(done, ["stop", "quit"]);
    const last = request();
    handler(last.event);
    assert.isFalse(last.held());
  });

  it("quits even when the stop failed", async () => {
    const { handler, done } = gate(true, () => Promise.reject(new Error("the stop died")));
    handler(request().event);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(done, ["stop", "quit"]);
  });
});
