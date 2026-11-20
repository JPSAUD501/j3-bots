// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Another program holding the port is a plain node:net server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ports from "./Ports.ts";

/** A port another program listens on, for as long as the test runs. */
const heldPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return address !== null && typeof address === "object" ? address.port : 0;
  }),
);

it.effect("names the port and the setting when another program holds it", () =>
  Effect.gen(function* () {
    const port = yield* heldPort;
    const exit = yield* Layer.build(
      Ports.listen(
        () => NodeHttp.createServer(),
        { host: "127.0.0.1", port },
        { label: "the bot tools", setting: "toolPort", host: "127.0.0.1", port },
        "/home/pi/.j3-bots/config.json",
      ),
    ).pipe(Effect.exit);
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    assert.isTrue(Option.isSome(error));
    if (Option.isSome(error)) {
      assert.strictEqual(error.value.code, "EADDRINUSE");
      assert.include(error.value.message, `Port ${port}, for the bot tools, is in use`);
      assert.include(error.value.message, '"toolPort" in /home/pi/.j3-bots/config.json');
    }
  }).pipe(Effect.scoped),
);
