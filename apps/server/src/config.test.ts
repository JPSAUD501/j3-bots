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
import { TEST_TLS } from "./testing/tls.ts";

const LAN_ONLY: ReadonlyArray<InterfaceAddress> = [
  { interface: "lo", address: "127.0.0.1", internal: true },
  { interface: "wlan0", address: "192.168.1.20", internal: false },
  { interface: "tailscale0", address: "100.101.102.103", internal: false },
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

  it.effect("refuses a home in a Git checkout, even before it exists or through a link", () =>
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

      // A home named through a link that leads into the checkout.
      const alias = path.join(yield* freshHome, "j3");
      yield* fs.makeDirectory(path.join(checkout, "state"));
      yield* fs.symlink(path.join(checkout, "state"), alias);
      for (const home of [alias, path.join(alias, "j3")]) {
        for (const step of [load, initializeHome]) {
          const exit = yield* withEnvironment(step, { J3_HOME: home }).pipe(Effect.exit);
          assert.deepInclude(failure(exit), {
            setting: "J3_HOME",
            reason: "home-in-git-checkout",
          });
        }
      }
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(checkout, "state")), []);
    }).pipe(Effect.scoped),
  );

  it.effect("serves plain HTTP only on loopback and private addresses", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      for (const host of [
        "127.0.0.1",
        "192.168.0.10",
        "169.254.3.4",
        "100.64.0.9",
        "::1",
        "fd7a::1",
      ]) {
        const config = yield* withEnvironment(load, { J3_HOME: home, J3_HOST: host });
        assert.strictEqual(config.host, host);
      }
      // Only an IP literal, written as Node binds it: a name could resolve
      // anywhere, and `010.0.0.1` is not the 10.0.0.1 it looks like.
      for (const host of [
        "0.0.0.0",
        "203.0.113.7",
        "::",
        "j3.example.com",
        "localhost",
        "010.0.0.1",
        "[::1]",
        "100.128.0.1",
      ]) {
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
        J3_TLS_CERT: TEST_TLS.cert,
        J3_TLS_KEY: TEST_TLS.key,
      });
      assert.isTrue(Option.isSome(withTls.tls));

      // Checked as the HTTPS listener would load them.
      for (const [cert, key] of [
        [TEST_TLS.cert, TEST_TLS.cert],
        [TEST_TLS.cert, "missing-key.pem"],
      ] as const) {
        const unusable = yield* withEnvironment(load, {
          J3_HOME: home,
          J3_TLS_CERT: cert,
          J3_TLS_KEY: key,
        }).pipe(Effect.exit);
        assert.deepInclude(failure(unusable), { reason: "tls-unusable" });
      }

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
        { interface: "eth0", address: "198.51.100.4", internal: false },
      ]).pipe(Effect.exit);
      assert.deepInclude(failure(exposed), {
        setting: "host",
        reason: "lan-has-public-address",
        subject: "198.51.100.4",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("gives each listener its own fixed port", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      const shared = yield* withEnvironment(load, { J3_HOME: home, J3_TOOL_PORT: "3737" }).pipe(
        Effect.exit,
      );
      assert.deepInclude(failure(shared), {
        setting: "port and J3_TOOL_PORT",
        reason: "port-conflict",
      });
      yield* writeConfigFile(home, JSON.stringify({ enginePort: 0 }));
      const dialed = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
      assert.deepInclude(failure(dialed), { reason: "port-zero" });
      // The server's own port may be the system's choice: clients learn it from `pair`.
      yield* writeConfigFile(home, JSON.stringify({ port: 0 }));
      assert.strictEqual((yield* withEnvironment(load, { J3_HOME: home })).port, 0);
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

  it.effect("refuses a web client folder that would publish the home or the TLS key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* freshHome;
      const home = path.join(parent, "home");
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(path.join(parent, "index.html"), "<!doctype html>");
      yield* fs.symlink(parent, path.join(parent, "linked"));

      for (const webClient of [parent, path.join(parent, "linked")]) {
        const exit = yield* withEnvironment(load, {
          J3_HOME: home,
          J3_WEB_CLIENT: webClient,
        }).pipe(Effect.exit);
        assert.deepInclude(failure(exit), { reason: "web-client-holds-state", subject: home });
      }

      const web = path.join(parent, "web");
      yield* fs.makeDirectory(web);
      yield* fs.writeFileString(path.join(web, "index.html"), "<!doctype html>");
      yield* fs.copyFile(TEST_TLS.key, path.join(web, "key.pem"));
      const exposedKey = yield* withEnvironment(load, {
        J3_HOME: home,
        J3_WEB_CLIENT: web,
        J3_TLS_CERT: TEST_TLS.cert,
        J3_TLS_KEY: path.join(web, "key.pem"),
      }).pipe(Effect.exit);
      assert.deepInclude(failure(exposedKey), { reason: "web-client-holds-state" });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a web client inside the home anywhere but its web folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* freshHome;
      const client = (folder: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(path.join(folder, "index.html"), "<!doctype html>");
          return folder;
        });
      const refusal = (webClient: string) =>
        withEnvironment(load, { J3_HOME: home, J3_WEB_CLIENT: webClient }).pipe(
          Effect.exit,
          Effect.map(failure),
        );

      assert.deepInclude(yield* refusal(yield* client(home)), {
        reason: "web-client-holds-state",
        subject: home,
      });
      for (const inside of ["engine", "bots/b1", "attachments", "shared/skills", "elsewhere"]) {
        assert.deepInclude(yield* refusal(yield* client(path.join(home, inside))), {
          reason: "web-client-in-home",
          subject: home,
        });
      }
      // The web folder is the client's, unless it leads into private state.
      const web = yield* client(path.join(home, "web", "dist"));
      assert.deepInclude(
        (yield* withEnvironment(load, { J3_HOME: home, J3_WEB_CLIENT: web })).webClient,
        { directory: web },
      );
      yield* fs.remove(path.join(home, "web"), { recursive: true });
      yield* fs.symlink(path.join(home, "engine"), path.join(home, "web"));
      assert.deepInclude(yield* refusal(path.join(home, "web")), {
        reason: "web-client-in-home",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a web client that overlaps private state the home links elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* freshHome;
      const home = path.join(root, "home");
      yield* fs.makeDirectory(path.join(home, "bots"), { recursive: true });
      const html = (folder: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(path.join(folder, "index.html"), "<!doctype html>");
          return folder;
        });
      const refusal = (webClient: string) =>
        withEnvironment(load, { J3_HOME: home, J3_WEB_CLIENT: webClient }).pipe(
          Effect.exit,
          Effect.map(failure),
        );

      const folders = ["engine", "bots/b1", "attachments", "shared"];
      const files = ["j3.sqlite", "j3.sqlite-wal", "admin.sock", "server.lock", "config.json"];
      for (const entry of [...folders, ...files]) {
        // The entry lives in its own folder outside the home, linked from it.
        const outside = path.join(root, "outside", entry.replaceAll("/", "-"));
        const target = path.join(outside, "state");
        if (folders.includes(entry)) yield* fs.makeDirectory(target, { recursive: true });
        else yield* fs.makeDirectory(outside, { recursive: true });
        if (!folders.includes(entry))
          yield* fs.writeFileString(target, entry === "config.json" ? "{}" : "");
        yield* fs.symlink(target, path.join(home, entry));

        assert.deepInclude(
          yield* refusal(yield* html(outside)),
          {
            reason: "web-client-holds-state",
            subject: path.join(home, entry),
          },
          entry,
        );
        if (folders.includes(entry)) {
          assert.deepInclude(
            yield* refusal(yield* html(path.join(target, "client"))),
            {
              reason: "web-client-in-state",
              subject: path.join(home, entry),
            },
            entry,
          );
        }
        yield* fs.remove(path.join(home, entry));
        yield* fs.remove(outside, { recursive: true });
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a home whose memory or engine adapter folder leads into the web client or out of the home, and leaves a bot's own folders to it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* freshHome;
        const home = path.join(root, "home");
        const web = path.join(root, "web");
        yield* fs.makeDirectory(web, { recursive: true });
        yield* fs.writeFileString(path.join(web, "index.html"), "<!doctype html>");
        const refusal = withEnvironment(load, { J3_HOME: home, J3_WEB_CLIENT: web }).pipe(
          Effect.exit,
          Effect.map(failure),
        );

        // Each memory folder sits inside a real folder of the home; only the
        // memory itself is a link.
        for (const memory of ["shared/memory", "bots/b1/memory", "engine/j3"]) {
          const linked = path.join(home, memory);
          yield* fs.makeDirectory(path.dirname(linked), { recursive: true });

          const published = path.join(web, memory.replaceAll("/", "-"));
          yield* fs.makeDirectory(published);
          yield* fs.symlink(published, linked);
          assert.deepInclude(
            yield* refusal,
            { reason: "web-client-holds-state", subject: linked },
            memory,
          );
          yield* fs.remove(linked);

          const elsewhere = path.join(root, "elsewhere", memory.replaceAll("/", "-"));
          yield* fs.makeDirectory(elsewhere, { recursive: true });
          yield* fs.symlink(elsewhere, linked);
          assert.deepInclude(
            yield* refusal,
            { reason: "state-outside-home", subject: linked },
            memory,
          );
          yield* fs.remove(linked);
        }
        // A bot's skills and files are its own: the server never writes them.
        for (const own of ["bots/b1/files", "bots/b1/skills"]) {
          const elsewhere = path.join(root, "elsewhere", own.replaceAll("/", "-"));
          yield* fs.makeDirectory(elsewhere, { recursive: true });
          yield* fs.symlink(elsewhere, path.join(home, own));
        }
        assert.deepInclude(
          (yield* withEnvironment(load, { J3_HOME: home, J3_WEB_CLIENT: web })).webClient,
          {
            directory: web,
          },
        );
      }).pipe(Effect.scoped),
  );
});
