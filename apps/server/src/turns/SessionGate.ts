// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * One serial lock per session (`docs/architecture/server.md`, One gate per
 * session). Every step that sends a session something runs through it: a
 * dispatch, a recovery, a held-queue resume and a Stop round. Each reads the
 * state it needs inside the gate, makes its engine call, records the result
 * and releases it; none holds it while it waits for events or backs off.
 *
 * The lock lives in the process. What makes the order hold across a restart is
 * that each step reads its state from the database inside the gate, and that
 * the server sends every unconfirmed Stop round before anything else
 * (`Turns.ts`).
 */
export class SessionGate extends Context.Service<
  SessionGate,
  {
    readonly run: (
      sessionId: string,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@j3-bots/server/turns/SessionGate") {}

export const layer = Layer.sync(SessionGate, () => {
  const gates = new Map<string, Semaphore.Semaphore>();
  const gateOf = (sessionId: string) => {
    const existing = gates.get(sessionId);
    if (existing !== undefined) return existing;
    const gate = Semaphore.makeUnsafe(1);
    gates.set(sessionId, gate);
    return gate;
  };
  return SessionGate.of({
    run:
      (sessionId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => gateOf(sessionId).withPermits(1)(effect)),
  });
});
