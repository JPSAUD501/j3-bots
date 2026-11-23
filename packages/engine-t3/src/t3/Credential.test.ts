// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { checkAccess, ensureCredential } from "./Credential.ts";
import { engineFolders, makePrivateFiles } from "./PrivateFiles.ts";

/**
 * An engine CLI that mints `token` on every `auth session issue`, and the
 * argument lists it was started with.
 */
const mintingCli = (token: string) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        calls.push(command.args.map((word) => (typeof word === "string" ? word : "<redacted>")));
      }
      const issued = JSON.stringify({ token, expiresAt: "2099-01-01T00:00:00.000Z" });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(issued)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { calls, spawner };
};

/** Mints with `cli` against a fresh engine home whose stored credential is `stored`. */
const ensureWith = (cli: ReturnType<typeof mintingCli>, stored: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const files = yield* makePrivateFiles(() => Effect.succeed(true));
    yield* files.write(
      path.join(engineFolders(path, home).j3, "credential.json"),
      JSON.stringify(stored),
    );
    return yield* ensureCredential({ executable: "/nonexistent/t3", home, files }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, SecureRandom.layerWebCrypto]));

const farFromExpiry = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(DateTime.addDuration(now, Duration.days(20))),
);

describe("ensureCredential", () => {
  it.effect("mints again a token stored without the browser scope, asking for it", () =>
    Effect.gen(function* () {
      const cli = mintingCli("fresh");
      // As J3 Bots before 0.4 stored it: no scopes recorded, minted without `preview:operate`.
      const credential = yield* ensureWith(cli, {
        token: "older",
        expiresAt: yield* farFromExpiry,
      });
      assert.strictEqual(Redacted.value(credential.token), "fresh");
      assert.strictEqual(cli.calls.length, 1);
      const args = cli.calls[0] ?? [];
      assert.isTrue(
        args.some((word, index) => word === "--scope" && args[index + 1] === "preview:operate"),
      );
    }),
  );

  it.effect("keeps a token stored with every scope", () =>
    Effect.gen(function* () {
      const cli = mintingCli("fresh");
      const credential = yield* ensureWith(cli, {
        token: "current",
        expiresAt: yield* farFromExpiry,
        scopes: ["orchestration:read", "orchestration:operate", "preview:operate"],
      });
      assert.strictEqual(Redacted.value(credential.token), "current");
      assert.strictEqual(cli.calls.length, 0);
    }),
  );
});

/** The engine's answer to `GET /api/auth/session`, as the pin gives it: older scopes apart. */
const sessionAnswer = (permissions: ReadonlyArray<string>) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: permissions.filter((scope) => scope.startsWith("orchestration:")),
          permissions,
          sessionMethod: "bearer-access-token",
        }),
      ),
    ),
  );

const accessWith = (permissions: ReadonlyArray<string>) =>
  checkAccess({ baseUrl: "http://127.0.0.1:1", token: Redacted.make("token") }).pipe(
    Effect.provideService(HttpClient.HttpClient, sessionAnswer(permissions)),
  );

describe("checkAccess", () => {
  it.effect("grants a token whose browser scope the engine lists among its permissions only", () =>
    Effect.gen(function* () {
      const all = ["orchestration:read", "orchestration:operate", "preview:operate"];
      assert.strictEqual(yield* accessWith(all), "granted");
      assert.strictEqual(yield* accessWith(all.slice(0, 2)), "refused");
    }),
  );
});
