// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { freePort } from "../smoke/host.ts";
import * as AdminClient from "../src/admin/AdminClient.ts";
import type { AdminStatus } from "../src/admin/protocol.ts";
import { HOME_ENTRIES } from "../src/home/entries.ts";

// The server side of the every-surface check
// (docs/operations/every-surface-check.md): a development server of this
// checkout on loopback, in a scratch home, with the scripted agent, so its
// bots run turns with no model. It listens on `J3_PORT` when that is set (the
// port a tunnel forwards), on a free port otherwise, and on free ports for the
// engine and the tool endpoint. Once the scripted agent is ready it prints the
// address and a pairing code for the check, and runs until it is stopped,
// which removes the scratch home.

const SERVER = `${import.meta.dirname}/../src/bin.ts`;
const SCRIPTED_AGENT = `${import.meta.dirname}/../../../packages/engine-t3/scripted-agent/agent.ts`;

/** The first start downloads the engine, about 200 MB. */
const READY_WITHIN = Duration.minutes(10);

const isReady = (status: AdminStatus) =>
  status.engine.state._tag === "ready" &&
  status.engine.providers.some(
    (provider) => provider.id === "scripted" && provider.status._tag === "ready",
  );

const host = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const admin = yield* AdminClient.AdminClient;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "j3-every-surface-" });
  const home = path.join(scratch, "home");
  const log = path.join(scratch, "server.log");
  const socket = path.join(home, HOME_ENTRIES.adminSocket);
  const port = yield* Config.option(Config.Port("J3_PORT"));

  const server = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
    ChildProcess.make(process.execPath, [SERVER, "serve"], {
      env: {
        J3_HOME: home,
        J3_HOST: "127.0.0.1",
        J3_PORT: String(Option.isSome(port) ? port.value : yield* freePort),
        J3_TOOL_PORT: String(yield* freePort),
        J3_ENGINE_PORT: String(yield* freePort),
        J3_SCRIPTED_AGENT: path.resolve(SCRIPTED_AGENT),
      },
      extendEnv: true,
      stdin: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "30 seconds",
    }),
  );
  yield* server.all.pipe(Stream.run(fs.sink(log)), Effect.forkScoped);
  yield* Console.log(`Starting the server in ${home}; its log is ${log}.`);

  const status = yield* admin.status(socket).pipe(
    Effect.flatMap((found) =>
      Option.isSome(found) && isReady(found.value)
        ? Effect.succeed(found.value)
        : Effect.fail("not ready" as const),
    ),
    Effect.retry(Schedule.spaced("1 second")),
    Effect.timeoutOrElse({
      duration: READY_WITHIN,
      orElse: () => Effect.die(`The server did not become ready; see ${log}.`),
    }),
  );
  const offer = yield* admin
    .startPairing(socket, { unlock: false })
    .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
  if (offer._tag !== "granted") return yield* Effect.die("Pairing is locked on a new server.");

  yield* Console.log(
    [
      `Listening on http://127.0.0.1:${status.listener.port}, with the scripted agent.`,
      `Pairing code for the check: ${offer.code} (it works once, for five minutes).`,
      `Another: J3_HOME=${home} node ${path.resolve(SERVER)} pair`,
      "Stop this command to remove the server and its home.",
    ].join("\n"),
  );
  return yield* Effect.never;
}).pipe(Effect.scoped);

host.pipe(
  Effect.provide(AdminClient.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
