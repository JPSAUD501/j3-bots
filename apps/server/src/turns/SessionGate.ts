// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { keyedLock } from "./keyedLock.ts";

/**
 * One serial lock per session (`docs/architecture/server.md`, One gate per
 * session). Every step that sends a session something runs through it: a
 * dispatch, a recovery, a held-queue resume and a Stop round. Each reads the
 * state it needs inside the gate, makes its engine call, records the result
 * and releases it; none holds it while it waits for events or backs off.
 *
 * The lock lives in the process. What makes the order hold across a restart is
 * that each step reads its state from the database inside the gate: a first
 * send finds an unsettled Stop of its session there, and is not made.
 */
export class SessionGate extends Context.Service<
  SessionGate,
  {
    readonly run: (
      sessionId: string,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@j3-bots/server/turns/SessionGate") {}

export const layer = Layer.sync(SessionGate, () => SessionGate.of({ run: keyedLock() }));
