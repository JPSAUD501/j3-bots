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
import { ServerConfig, layer } from "./config.ts";

const load = (env: Record<string, string>) =>
  Effect.service(ServerConfig).pipe(
    Effect.provide(
      layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))),
    ),
  );

/** A home outside any Git checkout, in the system's temporary folder. */
const freshHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.layer(NodeServices.layer)("server configuration", (it) => {
  it.effect("fails on a setting that is present but invalid instead of using its default", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      const exit = yield* load({ J3_HOME: home, J3_PORT: "37a7" }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a home inside a Git checkout, even before the home exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* freshHome;
      yield* fs.makeDirectory(path.join(checkout, ".git"));

      const exit = yield* load({ J3_HOME: path.join(checkout, "state", "j3") }).pipe(Effect.exit);
      assert.deepInclude(refusal(exit), { setting: "J3_HOME", reason: "home-in-git-checkout" });
    }).pipe(Effect.scoped),
  );

  it.effect("serves plain HTTP only on loopback and private addresses", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      for (const host of ["127.0.0.1", "localhost", "192.168.0.10", "100.101.102.103", "::1"]) {
        const config = yield* load({ J3_HOME: home, J3_HOST: host });
        assert.strictEqual(config.host, host);
      }
      for (const host of ["0.0.0.0", "203.0.113.7", "::", "j3.example.com"]) {
        const exit = yield* load({ J3_HOME: home, J3_HOST: host }).pipe(Effect.exit);
        assert.deepInclude(refusal(exit), {
          setting: "J3_HOST",
          reason: "public-address-without-tls",
        });
      }
      const withTls = yield* load({
        J3_HOME: home,
        J3_HOST: "0.0.0.0",
        J3_TLS_CERT: "cert.pem",
        J3_TLS_KEY: "key.pem",
      });
      assert.isTrue(Option.isSome(withTls.tls));
    }).pipe(Effect.scoped),
  );
});
