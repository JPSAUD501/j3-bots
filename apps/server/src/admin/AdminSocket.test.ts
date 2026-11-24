// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A request the admin client would refuse to send is sent with node:http.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HTTP_PATHS, MAX_LABEL_LENGTH, PairingCode, type PairResult } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import * as Home from "../home/Home.ts";
import * as Http from "../http.ts";
import * as ServerStop from "../ServerStop.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as WebClient from "../web/WebClient.ts";
import * as AdminClient from "./AdminClient.ts";
import * as AdminSocket from "./AdminSocket.ts";
import { ADMIN_PATHS, type PairingOffer } from "./protocol.ts";

/**
 * The admin socket of a server holding the test home, with the server's web
 * client decision and the test domain's listener.
 */
const adminServer = AdminSocket.layer.pipe(Layer.provide([Home.layer, ServerStop.layer]));

/** Another user of this machine, whom `sudo -n -u` runs commands as, for the test that needs one. */
const otherUser = process.env["J3_TEST_OTHER_USER"];

/** Connects to the Unix socket at its first argument, and prints the error's name, or "connected". */
const CONNECT = [
  "import errno, socket, sys",
  "s = socket.socket(socket.AF_UNIX)",
  "try:",
  "    s.connect(sys.argv[1])",
  "    print('connected')",
  "except OSError as e:",
  "    print(errno.errorcode[e.errno])",
].join("\n");

/** The device an answer pairs; none fails the test. */
const paired = <E, R>(
  answer: Effect.Effect<Option.Option<PairResult>, E, R>,
): Effect.Effect<PairResult, E, R> =>
  answer.pipe(
    Effect.flatMap((grant) =>
      Option.isSome(grant) ? Effect.succeed(grant.value) : Effect.die("no server answered"),
    ),
  );

/** The status a request with `token` as its bearer gets on the client listener. */
const ticketStatus = (token: string) =>
  HttpClient.execute(
    HttpClientRequest.post(HTTP_PATHS.socketTicket).pipe(HttpClientRequest.bearerToken(token)),
  ).pipe(Effect.map((response) => response.status));

/** POSTs `body` as JSON to `path` on the admin socket at `socket`, and answers the status. */
const postToSocket = (socket: string, path: string, body: string) =>
  Effect.callback<number>((resume) => {
    NodeHttp.request(
      {
        socketPath: socket,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      },
    ).end(body);
  });

/** The code an offer grants; anything else fails the test. */
const granted = <E, R>(
  offer: Effect.Effect<Option.Option<PairingOffer>, E, R>,
): Effect.Effect<Extract<PairingOffer, { readonly _tag: "granted" }>, E, R> =>
  offer.pipe(
    Effect.flatMap((answer) =>
      Option.isSome(answer) && answer.value._tag === "granted"
        ? Effect.succeed(answer.value)
        : Effect.die(`expected a code, got ${JSON.stringify(answer)}`),
    ),
  );

it.layer(AdminClient.layer.pipe(Layer.provideMerge(TestDomain.layer)))("admin socket", (it) => {
  it.effect("pairs a first device through the running server, and only then", () =>
    Effect.gen(function* () {
      const { adminSocket, home } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const devices = yield* Devices;
      assert.isTrue(Option.isNone(yield* admin.startPairing(adminSocket, { unlock: false })));

      yield* Effect.gen(function* () {
        const before = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(before)?.pairedDevices, 0);
        assert.deepStrictEqual(Option.getOrUndefined(before)?.listener, {
          scheme: "http",
          address: "0.0.0.0",
          port: 3737,
          names: [],
        });

        const grant = yield* granted(admin.startPairing(adminSocket, { unlock: false }));
        yield* devices.pair({ code: grant.code, name: "Phone" });

        const after = yield* admin.status(adminSocket);
        assert.strictEqual(Option.getOrUndefined(after)?.pairedDevices, 1);

        // A second server for the same home stops before it opens anything.
        const second = yield* Home.reserve.pipe(Effect.scoped, Effect.exit);
        const refusal = Exit.isFailure(second) ? Exit.findErrorOption(second) : Option.none();
        assert.deepInclude(Option.getOrUndefined(refusal), { _tag: "ServerAlreadyRunning", home });
      }).pipe(
        Effect.provide(adminServer.pipe(Layer.provide(WebClient.statusLayer))),
        Effect.scoped,
      );

      // Closing removed the socket: the server is gone, not unreachable.
      assert.isTrue(Option.isNone(yield* admin.status(adminSocket)));
    }),
  );

  it.effect("lifts a lock on pairing from the host, and pairs at once", () =>
    Effect.gen(function* () {
      const { adminSocket } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const devices = yield* Devices;
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* devices
            .pair({ code: PairingCode.make("0000000000"), name: "Guess" })
            .pipe(Effect.ignore);
        }
        const locked = yield* admin.startPairing(adminSocket, { unlock: false });
        assert.strictEqual(Option.getOrUndefined(locked)?._tag, "locked");

        const grant = yield* granted(admin.startPairing(adminSocket, { unlock: true }));
        const paired = yield* devices.pair({ code: grant.code, name: "Phone" }).pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(paired));
      }).pipe(
        Effect.provide(adminServer.pipe(Layer.provide(WebClient.statusLayer))),
        Effect.scoped,
      );
    }),
  );

  it.effect("reports the web client as the server decided to serve it, not as it is on disk", () =>
    Effect.gen(function* () {
      const { adminSocket, webClient } = yield* ServerConfig;
      const admin = yield* AdminClient.AdminClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* Effect.gen(function* () {
        // Built after the server decided it had no client to serve.
        yield* fs.makeDirectory(webClient.directory, { recursive: true });
        yield* fs.writeFileString(path.join(webClient.directory, "index.html"), "<!doctype html>");
        yield* Effect.gen(function* () {
          const page = yield* HttpClient.execute(
            HttpClientRequest.get("/").pipe(HttpClientRequest.setHeader("accept", "text/html")),
          );
          assert.strictEqual(page.status, 404);
          const status = yield* admin.status(adminSocket);
          assert.strictEqual(Option.getOrUndefined(status)?.webClient, "not-built");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              adminServer,
              Ports.serve(WebClient.layer, NodeHttpServer.layerTest, { logAddress: false }),
            ),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.provide(WebClient.statusLayer));
    }),
  );
});

it.layer(AdminClient.layer.pipe(Layer.provideMerge(TestDomain.layer)))(
  "the desktop's own device",
  (it) => {
    it.effect(
      "is paired without a code, replaces the one before it, and only on the admin socket",
      () =>
        Effect.gen(function* () {
          const { adminSocket } = yield* ServerConfig;
          const admin = yield* AdminClient.AdminClient;
          const devices = yield* Devices;
          const auth = yield* DeviceAuth;
          yield* Effect.gen(function* () {
            // It takes no code, so a lock on pairing does not hold it back.
            for (let attempt = 0; attempt < 5; attempt++) {
              yield* devices
                .pair({ code: PairingCode.make("0000000000"), name: "Guess" })
                .pipe(Effect.ignore);
            }
            assert.isTrue(Option.isSome(yield* devices.lockedUntil));

            const first = yield* paired(
              admin.localDevice(adminSocket, { name: "This computer", replaces: null }),
            );
            assert.strictEqual(yield* ticketStatus(first.token), 200);
            const firstClosed = yield* Effect.forkChild(auth.revoked(first.deviceId));

            const second = yield* paired(
              admin.localDevice(adminSocket, { name: "This computer", replaces: first.deviceId }),
            );
            // The device it replaced is signed out at once: its sockets close.
            yield* Fiber.join(firstClosed);
            assert.strictEqual(yield* ticketStatus(first.token), 401);
            assert.strictEqual(yield* ticketStatus(second.token), 200);
            assert.deepStrictEqual(
              (yield* devices.paired).map((device) => device.id),
              [second.deviceId],
            );

            // A device it names that is gone already is no reason to refuse.
            const third = yield* paired(
              admin.localDevice(adminSocket, { name: "This computer", replaces: first.deviceId }),
            );
            assert.strictEqual(yield* ticketStatus(third.token), 200);
            assert.strictEqual(yield* devices.pairedCount, 2);

            // A name is held to a pairing device's rules.
            const named = (name: string) =>
              postToSocket(
                adminSocket,
                ADMIN_PATHS.localDevice,
                JSON.stringify({ name, replaces: null }),
              );
            assert.strictEqual(yield* named(""), 400);
            assert.strictEqual(yield* named("x".repeat(MAX_LABEL_LENGTH + 1)), 400);

            // Nothing on the network reaches it: the client listener has no such route.
            const onListener = yield* HttpClient.execute(
              HttpClientRequest.post(ADMIN_PATHS.localDevice).pipe(
                HttpClientRequest.bodyText(
                  JSON.stringify({ name: "Laptop", replaces: null }),
                  "application/json",
                ),
              ),
            );
            assert.strictEqual(onListener.status, 404);
            assert.strictEqual(yield* devices.pairedCount, 2);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                adminServer,
                Http.serve(NodeHttpServer.layerTest, { logAddress: false }),
              ).pipe(Layer.provide(Layer.merge(WebClient.statusLayer, TestUpdates.layer))),
            ),
            Effect.scoped,
          );
        }),
    );

    it.effect("asks the server to stop, and answers first", () =>
      Effect.gen(function* () {
        const { adminSocket } = yield* ServerConfig;
        const admin = yield* AdminClient.AdminClient;
        yield* Effect.gen(function* () {
          const stop = yield* ServerStop.ServerStop;
          const stopped = yield* Effect.forkChild(stop.requested);
          assert.isTrue(Option.isSome(yield* admin.shutdown(adminSocket)));
          yield* Fiber.join(stopped);
        }).pipe(
          Effect.provide(
            AdminSocket.layer.pipe(
              Layer.provide([Home.layer, WebClient.statusLayer]),
              Layer.provideMerge(ServerStop.layer),
            ),
          ),
          Effect.scoped,
        );
      }),
    );

    it.effect("creates the admin socket closed to other users, whatever the umask", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const socket = path.join(yield* fs.makeTempDirectoryScoped(), "admin.sock");
        // The most open umask: a socket bound under it is anyone's from the
        // bind until a chmod, unless the server narrows it for the bind.
        const usual = process.umask(0);
        yield* Effect.addFinalizer(() => Effect.sync(() => process.umask(usual)));
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => new AdminSocket.PrivateSocketServer()),
          (server) => Effect.sync(() => server.close()),
        );
        server.listen(socket);
        // The umask is the test's again once the bind is done.
        assert.strictEqual(process.umask(0), 0);
        const { mode } = yield* fs.stat(socket);
        assert.strictEqual(mode & 0o077, 0, `mode ${(mode & 0o777).toString(8)}`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect.skipIf(otherUser === undefined)(
      "keeps another user of the machine off the admin socket",
      () =>
        Effect.gen(function* () {
          const { adminSocket } = yield* ServerConfig;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          yield* Effect.gen(function* () {
            // The system's Python, which any user may run, as this test's Node
            // may sit in a home the other user cannot enter.
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "sudo",
                ["-n", "-u", otherUser ?? "", "/usr/bin/python3", "-c", CONNECT, adminSocket],
                { stdin: "ignore" },
              ),
            );
            const [output, errors] = yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.decodeText, Stream.mkString),
                handle.exitCode,
              ],
              { concurrency: 3 },
            );
            assert.strictEqual(output.trim(), "EACCES", errors);
          }).pipe(
            Effect.provide(adminServer.pipe(Layer.provide(WebClient.statusLayer))),
            Effect.scoped,
          );
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
