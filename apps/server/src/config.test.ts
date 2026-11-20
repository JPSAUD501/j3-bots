// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { DEFAULTS, initializeHome, load } from "./config.ts";
import { type InterfaceAddress, Network } from "./system/Network.ts";

const LAN_ONLY: ReadonlyArray<InterfaceAddress> = [
  { address: "127.0.0.1", internal: true },
  { address: "192.168.1.20", internal: false },
  { address: "100.101.102.103", internal: false },
];

const withEnvironment = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: Record<string, string>,
  addresses: ReadonlyArray<InterfaceAddress> = LAN_ONLY,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
        Layer.succeed(Network, Network.of({ ipv4Addresses: Effect.succeed(addresses) })),
      ),
    ),
  );

/** A home outside any Git checkout, in the system's temporary folder. */
const freshHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

const writeConfigFile = Effect.fn("writeConfigFile")(function* (home: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(home, "config.json"), text);
});

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.layer(NodeServices.layer)("server configuration", (it) => {
  it.effect("takes each setting from the environment, else the file, else its default", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      yield* writeConfigFile(home, JSON.stringify({ port: 4000, toolPort: 4001 }));
      const config = yield* withEnvironment(load, { J3_HOME: home, J3_PORT: "5000" });
      assert.strictEqual(config.port, 5000);
      assert.strictEqual(config.toolPort, 4001);
      assert.strictEqual(config.enginePort, DEFAULTS.enginePort);
    }).pipe(Effect.scoped),
  );

  it.effect("fails on a setting that is present but invalid instead of using its default", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      const fromEnv = yield* withEnvironment(load, { J3_HOME: home, J3_PORT: "37a7" }).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(fromEnv));

      for (const text of [
        JSON.stringify({ port: 70000 }),
        JSON.stringify({ prot: 3737 }),
        JSON.stringify({ host: "" }),
        "{ port: 3737 }",
      ]) {
        yield* writeConfigFile(home, text);
        const fromFile = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
        assert.deepInclude(failure(fromFile), { _tag: "ConfigFileInvalid" }, text);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("writes every default on first run, and never rewrites the operator's file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* freshHome;
      const home = path.join(parent, "j3");
      const env = { J3_HOME: home };

      yield* withEnvironment(initializeHome, env);
      const first = yield* withEnvironment(load, env);
      assert.strictEqual(first.port, DEFAULTS.port);
      assert.strictEqual((yield* fs.stat(home)).mode & 0o777, 0o700);

      yield* writeConfigFile(home, JSON.stringify({ port: 4000 }));
      yield* withEnvironment(initializeHome, env);
      assert.strictEqual((yield* withEnvironment(load, env)).port, 4000);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a home inside a Git checkout, even before the home exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* freshHome;
      yield* fs.makeDirectory(path.join(checkout, ".git"));

      const env = { J3_HOME: path.join(checkout, "state", "j3") };
      for (const step of [load, initializeHome]) {
        const exit = yield* withEnvironment(step, env).pipe(Effect.exit);
        assert.deepInclude(failure(exit), { setting: "J3_HOME", reason: "home-in-git-checkout" });
      }
      assert.isFalse(yield* fs.exists(path.join(checkout, "state")));
    }).pipe(Effect.scoped),
  );

  it.effect("serves plain HTTP only on loopback and private addresses", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      for (const host of ["127.0.0.1", "localhost", "192.168.0.10", "169.254.3.4", "::1"]) {
        const config = yield* withEnvironment(load, { J3_HOME: home, J3_HOST: host });
        assert.strictEqual(config.host, host);
      }
      for (const host of ["0.0.0.0", "203.0.113.7", "::", "j3.example.com"]) {
        const exit = yield* withEnvironment(load, { J3_HOME: home, J3_HOST: host }).pipe(
          Effect.exit,
        );
        assert.deepInclude(failure(exit), {
          setting: "J3_HOST",
          reason: "public-address-without-tls",
        });
      }
      const withTls = yield* withEnvironment(load, {
        J3_HOME: home,
        J3_HOST: "0.0.0.0",
        J3_TLS_CERT: "cert.pem",
        J3_TLS_KEY: "key.pem",
      });
      assert.isTrue(Option.isSome(withTls.tls));

      const halfTls = yield* withEnvironment(load, { J3_HOME: home, J3_TLS_CERT: "cert.pem" }).pipe(
        Effect.exit,
      );
      assert.deepInclude(failure(halfTls), { reason: "tls-incomplete" });
    }).pipe(Effect.scoped),
  );

  it.effect("listens on every interface for lan, only while all of them are private", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      const lan = yield* withEnvironment(load, { J3_HOME: home });
      assert.strictEqual(lan.host, "0.0.0.0");

      const exposed = yield* withEnvironment(load, { J3_HOME: home }, [
        ...LAN_ONLY,
        { address: "198.51.100.4", internal: false },
      ]).pipe(Effect.exit);
      assert.deepInclude(failure(exposed), {
        setting: "host",
        reason: "lan-has-public-address",
        subject: "198.51.100.4",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("serves a configured web client only if it is built", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* freshHome;
      yield* fs.makeDirectory(path.join(home, "web"));
      yield* writeConfigFile(home, JSON.stringify({ webClient: "web" }));

      const missing = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
      assert.deepInclude(failure(missing), { reason: "web-client-missing" });

      yield* fs.writeFileString(path.join(home, "web", "index.html"), "<!doctype html>");
      const config = yield* withEnvironment(load, { J3_HOME: home });
      assert.deepStrictEqual(config.webClient, {
        _tag: "configured",
        directory: path.join(home, "web"),
      });
    }).pipe(Effect.scoped),
  );
});
