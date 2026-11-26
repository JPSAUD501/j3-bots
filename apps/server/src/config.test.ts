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
import * as PlatformError from "effect/PlatformError";
import { hasAdminSocket } from "./admin/socket.ts";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { DEFAULTS, load } from "./config.ts";
import { initialize } from "./home/Home.ts";
import { isPrivate, openToOthers, runInCommandPrompt } from "./home/testPrivacy.ts";
import { markRestoring, takeSnapshot } from "./install/snapshot.ts";
import { type InterfaceAddress, Network } from "./system/Network.ts";
import { TEST_TLS } from "./testing/tls.ts";

const LAN_ONLY: ReadonlyArray<InterfaceAddress> = [
  { interface: "lo", address: "127.0.0.1", internal: true },
  { interface: "wlan0", address: "192.168.1.20", internal: false },
  { interface: "tailscale0", address: "100.72.9.41", internal: false },
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
  const path = yield* Path.Path;
  // Resolved, as the server resolves the home: on Windows the folder comes back with a `/` in it.
  return path.resolve(yield* fs.makeTempDirectoryScoped());
});

const writeConfigFile = Effect.fn("writeConfigFile")(function* (home: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(home, "config.json"), text);
});

/** A disk with no space left: the home can still be opened for writing, but no write lands. */
const fullDisk = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => {
    const full = (method: string) => () =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method,
          description: "No space left on device",
        }),
      );
    return FileSystem.FileSystem.of({ ...fs, writeFile: full("writeFile"), link: full("link") });
  }),
);

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

  it.effect("fails on a config.json it may not read instead of starting on the defaults", () =>
    Effect.gen(function* () {
      const home = yield* freshHome;
      yield* writeConfigFile(home, JSON.stringify({ port: 4000 }));
      const exit = yield* withEnvironment(load, { J3_HOME: home }).pipe(
        Effect.provide(
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fs) =>
              FileSystem.FileSystem.of({
                ...fs,
                readFileString: (path, encoding) =>
                  path.endsWith("config.json")
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "readFile",
                          pathOrDescriptor: path,
                        }),
                      )
                    : fs.readFileString(path, encoding),
              }),
            ),
          ),
        ),
        Effect.exit,
      );
      assert.deepInclude(failure(exit), {
        _tag: "ConfigFileUnreadable",
        reason: "PermissionDenied",
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "takes a public origin only as a bare https origin, written as a browser writes it",
    () =>
      Effect.gen(function* () {
        const home = yield* freshHome;
        yield* writeConfigFile(home, JSON.stringify({ publicOrigin: "https://bots.example.com" }));
        const config = yield* withEnvironment(load, { J3_HOME: home });
        assert.deepStrictEqual(config.publicOrigin, Option.some("https://bots.example.com"));

        for (const publicOrigin of [
          "http://bots.example.com",
          "https://bots.example.com/",
          "https://bots.example.com/j3",
          "https://bots.example.com:443",
          "https://Bots.example.com",
          "https://user@bots.example.com",
          "bots.example.com",
        ]) {
          yield* writeConfigFile(home, JSON.stringify({ publicOrigin }));
          const refused = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
          assert.deepInclude(failure(refused), { _tag: "ConfigFileInvalid" }, publicOrigin);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("takes a scripted agent only where its file is, a path in the file from the home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* freshHome;
      const agent = path.join(home, "checkout", "agent.ts");
      yield* fs.makeDirectory(path.dirname(agent));
      yield* fs.writeFileString(agent, "");
      yield* writeConfigFile(home, JSON.stringify({ scriptedAgent: "checkout/agent.ts" }));
      const config = yield* withEnvironment(load, { J3_HOME: home });
      assert.deepStrictEqual(config.scriptedAgent, Option.some(agent));

      for (const missing of ["checkout/other.ts", "checkout"]) {
        yield* writeConfigFile(home, JSON.stringify({ scriptedAgent: missing }));
        const refused = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
        assert.deepInclude(
          failure(refused),
          { _tag: "ConfigRefused", reason: "scripted-agent-missing" },
          missing,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("writes every default on first run, and never rewrites the operator's file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* freshHome;
      const home = path.join(parent, "j3");
      const env = { J3_HOME: home };

      yield* withEnvironment(initialize, env);
      const first = yield* withEnvironment(load, env);
      assert.strictEqual(first.port, DEFAULTS.port);
      assert.isTrue(yield* isPrivate(home));

      yield* writeConfigFile(home, JSON.stringify({ port: 4000 }));
      // On a full disk, a start that finds the file has nothing to write.
      const full = yield* withEnvironment(initialize, env).pipe(Effect.provide(fullDisk));
      assert.strictEqual(full.port, 4000);
      assert.strictEqual((yield* withEnvironment(load, env)).port, 4000);
    }).pipe(Effect.scoped),
  );

  it.effect("checks a home another process made while the server was creating it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* freshHome;
      const home = path.join(parent, "j3");
      const outside = yield* Effect.context<
        FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
      >();
      // Once the server has found the home missing, another process makes it, open to others.
      const racing = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          makeDirectory: (target, options) =>
            fs
              .makeDirectory(target, options)
              .pipe(
                Effect.andThen(
                  path.resolve(target) === parent
                    ? fs
                        .makeDirectory(home)
                        .pipe(
                          Effect.andThen(openToOthers(home)),
                          Effect.provide(outside),
                          Effect.orDie,
                        )
                    : Effect.void,
                ),
              ),
        }),
      );
      const exit = yield* withEnvironment(initialize, { J3_HOME: home }).pipe(
        Effect.provide(racing),
        Effect.exit,
      );
      assert.deepInclude(failure(exit), { _tag: "HomeNotPrivate", reason: "open-to-others" });
      assert.isFalse(yield* fs.exists(path.join(home, "config.json")));
    }).pipe(Effect.scoped),
  );

  it.effect("writes nothing in a home it refuses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A home inside the web client's folder, which would publish it.
      const client = yield* freshHome;
      yield* fs.writeFileString(path.join(client, "index.html"), "<!doctype html>");
      const published = path.join(client, "j3");
      const inClient = yield* withEnvironment(initialize, {
        J3_HOME: published,
        J3_WEB_CLIENT: client,
      }).pipe(Effect.exit);
      assert.deepInclude(failure(inClient), { reason: "web-client-holds-state" });
      assert.isFalse(yield* fs.exists(published));

      // A home other users can open.
      const open = yield* freshHome;
      yield* openToOthers(open);
      const shared = yield* withEnvironment(initialize, { J3_HOME: open }).pipe(Effect.exit);
      assert.deepInclude(failure(shared), { reason: "open-to-others" });
      assert.isFalse(yield* fs.exists(path.join(open, "config.json")));

      // A home this user cannot write to, though it holds a readable file:
      // by its mode, which means nothing on Windows (see windowsAcl.test.ts).
      if (process.platform !== "win32") {
        const locked = yield* freshHome;
        yield* writeConfigFile(locked, "{}");
        yield* fs.chmod(locked, 0o500);
        const closed = yield* withEnvironment(initialize, { J3_HOME: locked }).pipe(
          Effect.exit,
          Effect.ensuring(fs.chmod(locked, 0o700).pipe(Effect.orDie)),
        );
        assert.deepInclude(failure(closed), {
          _tag: "HomeNotPrivate",
          reason: "closed-to-owner",
        });
      }

      // A home a rollback left with its config.json moved aside, the snapshot's not yet in.
      const halfRestored = yield* freshHome;
      yield* writeConfigFile(halfRestored, "{}");
      yield* markRestoring(
        yield* takeSnapshot({
          home: halfRestored,
          from: { version: "0.0.0-before" },
          to: { version: "0.0.0-after" },
        }),
      );
      yield* fs.remove(path.join(halfRestored, "config.json"));
      const unfinished = yield* withEnvironment(initialize, { J3_HOME: halfRestored }).pipe(
        Effect.exit,
      );
      assert.deepInclude(failure(unfinished), { _tag: "RollbackUnfinished" });
      assert.isFalse(yield* fs.exists(path.join(halfRestored, "config.json")));
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform !== "win32")(
    "on Windows, takes a home named by its short 8.3 name, and still refuses a junction out of it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* freshHome;
        const long = path.join(root, "a folder with a long name");
        yield* fs.makeDirectory(long);
        // `%TEMP%` under a profile whose name is long or has a space is such a
        // name (`C:\Users\LONGNA~1\...`); its real path is the long one.
        const short = (yield* spawner.string(
          ChildProcess.make(`for %I in ("${long}") do @echo %~sI`, { shell: true }),
        )).trim();
        assert.notStrictEqual(
          short.toLowerCase(),
          long.toLowerCase(),
          "this volume makes no 8.3 names, which this test needs",
        );
        const home = path.join(short, "j3");
        yield* withEnvironment(initialize, { J3_HOME: home });
        const config = yield* withEnvironment(load, { J3_HOME: home });
        assert.strictEqual(config.home, home);

        // A junction needs no privilege, so it is the link anyone can make.
        const linked = path.join(home, "engine", "j3");
        const elsewhere = path.join(root, "elsewhere");
        yield* fs.makeDirectory(path.dirname(linked), { recursive: true });
        yield* fs.makeDirectory(elsewhere);
        yield* runInCommandPrompt(`mklink /J "${linked}" "${elsewhere}"`);
        assert.deepInclude(
          failure(yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit)),
          { reason: "state-outside-home", subject: linked },
        );
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a home in a Git checkout, even before it exists or through a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* freshHome;
      yield* fs.makeDirectory(path.join(checkout, ".git"));

      const env = { J3_HOME: path.join(checkout, "state", "j3") };
      for (const step of [load, initialize]) {
        const exit = yield* withEnvironment(step, env).pipe(Effect.exit);
        assert.deepInclude(failure(exit), { setting: "J3_HOME", reason: "home-in-git-checkout" });
      }
      assert.isFalse(yield* fs.exists(path.join(checkout, "state")));

      // A home named through a link that leads into the checkout.
      const alias = path.join(yield* freshHome, "j3");
      yield* fs.makeDirectory(path.join(checkout, "state"));
      yield* fs.symlink(path.join(checkout, "state"), alias);
      for (const home of [alias, path.join(alias, "j3")]) {
        for (const step of [load, initialize]) {
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

  it.effect("refuses a home too long for the admin socket only where it binds one", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join(yield* freshHome, "h".repeat(120));
      const exit = yield* withEnvironment(load, { J3_HOME: home }).pipe(Effect.exit);
      if (hasAdminSocket(process.platform)) {
        assert.deepInclude(failure(exit), { setting: "J3_HOME", reason: "home-path-too-long" });
      } else {
        // No socket on Windows, so its path's limit is not the home's.
        assert.isTrue(Exit.isSuccess(exit), String(failure(exit)));
      }
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
      assert.isTrue(lan.privateOnly);

      const exposedMachine = [
        ...LAN_ONLY,
        { interface: "eth0", address: "198.51.100.4", internal: false },
      ];
      const tls = { J3_TLS_CERT: TEST_TLS.cert, J3_TLS_KEY: TEST_TLS.key };
      // A certificate serves HTTPS, but `lan` still serves private addresses only.
      for (const env of [{ J3_HOME: home }, { J3_HOME: home, ...tls }]) {
        const exposed = yield* withEnvironment(load, env, exposedMachine).pipe(Effect.exit);
        assert.deepInclude(failure(exposed), {
          setting: "host",
          reason: "lan-has-public-address",
          subject: "198.51.100.4",
        });
      }
      assert.isTrue((yield* withEnvironment(load, { J3_HOME: home, ...tls })).privateOnly);

      // An address set explicitly with TLS is served whatever it is.
      const everywhere = yield* withEnvironment(
        load,
        { J3_HOME: home, J3_HOST: "0.0.0.0", ...tls },
        exposedMachine,
      );
      assert.isFalse(everywhere.privateOnly);
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
