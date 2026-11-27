// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Real listeners, one unreferenced, for Node's own diagnostic report to list.
import * as NodeNet from "node:net";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { holdersIn, type Lingering, watchStop } from "./Lingering.ts";

/** A listener on loopback for as long as the scope lives, unreferenced if asked; its port. */
const listening = (referenced: boolean) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeNet.Server; readonly port: number }>((resume) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!referenced) server.unref();
        resume(
          address !== null && typeof address === "object"
            ? Effect.succeed({ server, port: address.port })
            : Effect.die(new Error("A listener on loopback has no port")),
        );
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ port }) => port));

describe("what keeps a stopping server's process running", () => {
  it.live("names what holds the process by where it listens, and leaves out what does not", () =>
    Effect.gen(function* () {
      const held = yield* listening(true);
      const unreferenced = yield* listening(false);

      const holding = holdersIn(process.report.getReport());

      assert.isTrue(Option.isSome(holding));
      const named = Option.getOrElse(holding, () => []);
      assert.include(named, `tcp on 127.0.0.1:${held}`);
      assert.notInclude(named, `tcp on 127.0.0.1:${unreferenced}`);
    }).pipe(Effect.scoped),
  );

  it.live("says, once a stop runs long, whether everything was released and what still holds", () =>
    Effect.gen(function* () {
      const held = yield* listening(true);
      const said = yield* Deferred.make<Lingering>();
      const stopping = yield* watchStop(Duration.millis(20), (lingering) =>
        Deferred.succeed(said, lingering).pipe(Effect.asVoid),
      );

      yield* stopping.begun;
      yield* stopping.released;
      const lingering = yield* Deferred.await(said);

      assert.isTrue(lingering.released);
      assert.include(lingering.holding ?? [], `tcp on 127.0.0.1:${held}`);
    }).pipe(Effect.scoped),
  );
});
