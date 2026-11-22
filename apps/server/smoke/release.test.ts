// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { CommandId, HTTP_PATHS, J3Rpcs, PairRequest, PairResult } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as AdminClient from "../src/admin/AdminClient.ts";
import { RELEASE_MANIFEST, ReleaseManifest } from "../src/installation.ts";
import { freePort, runToEnd, searchPathWithoutNode } from "./host.ts";

// A release archive, as `pnpm release` builds it, run as a stranger would run
// it: unpacked anywhere, with no Node on PATH. Its doctor runs; it fetches the
// engine it is pinned to; its server answers /health, serves the archive's web
// client and starts that engine; and a paired client gets a bot's reply
// through the engine, from the scripted agent. Needs the archive in J3_RELEASE_ARCHIVE and the
// network, to download the engine.

const ENGINE_READY_WITHIN = Duration.minutes(2);
const TURN_WITHIN = Duration.minutes(1);

const SCRIPTED_AGENT = `${import.meta.dirname}/../../../packages/engine-t3/scripted-agent/agent.ts`;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest));

const services = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  AdminClient.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.layer(services, { excludeTestServices: true })("release archive", (it) => {
  it.effect(
    "runs with no Node on PATH: doctor, the web client, and a bot's turn on the pinned engine",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const archive = yield* Config.String("J3_RELEASE_ARCHIVE");
        const scratch = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "j3-release-" }),
        );

        // Unpacked as a stranger would, then run from wherever it landed.
        const into = path.join(scratch, "unpacked");
        yield* fs.makeDirectory(into);
        const unpacked = yield* runToEnd(ChildProcess.make("tar", ["-xzf", archive, "-C", into]));
        assert.strictEqual(unpacked.exitCode, 0, unpacked.output);
        const [folder, ...others] = yield* fs.readDirectory(into);
        if (folder === undefined || others.length > 0) {
          return assert.fail(
            `The archive holds ${[folder, ...others].join(", ")}, not one folder.`,
          );
        }
        const release = path.join(into, folder);
        const launcher = path.join(release, "bin", "j3-bots");
        const manifest = yield* fs
          .readFileString(path.join(release, RELEASE_MANIFEST))
          .pipe(Effect.flatMap(decodeManifest));

        // Only the archive's Node can run.
        const commands = yield* searchPathWithoutNode(path.join(scratch, "commands"));
        const home = path.join(scratch, "home");
        const userHome = path.join(scratch, "user");
        yield* fs.makeDirectory(userHome);
        const env: Record<string, string> = {
          PATH: commands,
          HOME: userHome,
          LANG: "C.UTF-8",
          J3_HOME: home,
          J3_HOST: "127.0.0.1",
          J3_PORT: String(yield* freePort),
          J3_TOOL_PORT: String(yield* freePort),
          J3_ENGINE_PORT: String(yield* freePort),
          J3_SCRIPTED_AGENT: path.resolve(SCRIPTED_AGENT),
        };
        // The engine starts each provider in a systemd scope of the user's manager.
        for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
          const value = yield* Config.option(Config.String(name));
          if (Option.isSome(value)) env[name] = value.value;
        }
        const withRelease = { env, extendEnv: false } as const;
        const noNode = yield* runToEnd(
          ChildProcess.make("sh", ["-c", "command -v node"], withRelease),
        );
        assert.notStrictEqual(noNode.exitCode, 0, `node is still on PATH: ${noNode.output}`);

        // doctor runs on the archive's Node and finds the archive's web client.
        const doctor = yield* runToEnd(ChildProcess.make(launcher, ["doctor"], withRelease));
        assert.include(doctor.output, `Node ${manifest.node}.`, doctor.output);
        assert.include(doctor.output, `Built in ${path.join(release, "web")}.`, doctor.output);
        assert.match(doctor.output, /(to fix|No problems|Everything J3 Bots needs)/, doctor.output);

        // The pinned engine, installed before the server that runs it starts.
        const fetched = yield* runToEnd(
          ChildProcess.make(launcher, ["engine", "fetch"], withRelease),
        );
        assert.strictEqual(fetched.exitCode, 0, fetched.output);
        assert.match(fetched.output, /T3 Code \S+ is installed: /, fetched.output);

        // The server, for as long as the test runs; its log goes to the test's.
        yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make(launcher, ["serve"], {
            ...withRelease,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            killSignal: "SIGTERM",
            forceKillAfter: "30 seconds",
          }),
        );
        const admin = yield* AdminClient.AdminClient;
        const socket = path.join(home, "admin.sock");
        const status = yield* admin.status(socket).pipe(
          Effect.flatMap((found) => Effect.fromOption(found)),
          Effect.retry(Schedule.spaced("500 millis")),
          Effect.timeout("1 minute"),
        );
        const origin = `http://127.0.0.1:${status.listener.port}`;

        const http = yield* HttpClient.HttpClient;
        const health = yield* http.get(`${origin}/health`).pipe(Effect.flatMap((r) => r.json));
        assert.deepStrictEqual(health, { status: "ok" });
        const page = yield* http.get(`${origin}/`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.text),
        );
        assert.strictEqual(page, yield* fs.readFileString(path.join(release, "web", "index.html")));

        // A device pairs, as from a browser, and opens the client socket.
        const grant = yield* admin
          .startPairing(socket, { unlock: false })
          .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
        if (grant._tag !== "granted") return yield* Effect.die("pairing is locked on a new server");
        const paired = yield* HttpClientRequest.post(`${origin}${HTTP_PATHS.pair}`).pipe(
          HttpClientRequest.schemaBodyJson(PairRequest)({
            code: grant.code,
            name: "Release smoke",
          }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(PairResult)),
        );
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(
              NodeSocket.layerWebSocket(`ws://127.0.0.1:${status.listener.port}${HTTP_PATHS.rpc}`, {
                headers: { authorization: `Bearer ${paired.token}` },
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));

        // The engine the archive is pinned to, downloaded and ready, offering the scripted agent.
        const engine = yield* client["engine.subscribe"]().pipe(
          Stream.filter(
            (current) =>
              current.state._tag === "ready" &&
              current.providers.some(
                (provider) => provider.id === "scripted" && provider.status._tag === "ready",
              ),
          ),
          Stream.runHead,
          Effect.flatMap((found) => Effect.fromOption(found)),
          Effect.timeout(ENGINE_READY_WITHIN),
        );
        assert.strictEqual(engine.pinnedVersion, status.engine.pinnedVersion);

        // One turn: the bot, on the scripted agent, says what the message asks.
        const bot = yield* client["bot.create"]({
          commandId: CommandId.make("release-smoke-bot"),
          name: "Smoke",
        });
        const target = { _tag: "conversation", botId: bot.id } as const;
        const reply = yield* client["entries.subscribe"]({ target, after: null }).pipe(
          Stream.flatMap((frame) =>
            Stream.fromIterable(frame._tag === "snapshot" ? frame.entries : frame.upsert),
          ),
          Stream.filter(
            (entry) =>
              entry._tag === "message" && entry.author._tag === "bot" && entry.text === "Hello",
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* client["message.send"]({
          commandId: CommandId.make("release-smoke-message"),
          target,
          text: "[[script:speak text=Hello]]",
          attachments: [],
        });
        const said = yield* Fiber.join(reply).pipe(Effect.timeout(TURN_WITHIN));
        assert.isTrue(Option.isSome(said));
      }).pipe(Effect.scoped),
    Duration.toMillis(Duration.minutes(10)),
  );
});
