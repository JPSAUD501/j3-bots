// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { holdsFile, serverEnvironment } from "./localHost.ts";

describe("the environment the server runs with", () => {
  const options = {
    path: "/home/ana/.local/bin:/usr/bin",
    home: "/data/server/home",
    host: "127.0.0.1",
    webClient: "/opt/J3 Bots/resources/web/dist",
  };

  it("keeps the operator's own variables, trusted certificates and say on usage data, and sets its PATH, home, address and web client, with no browser of its own", () => {
    const env = serverEnvironment(
      {
        HOME: "/home/ana",
        LANG: "pt_BR.UTF-8",
        ANTHROPIC_LOG: "debug",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/company-proxy.pem",
        J3_TELEMETRY_ENABLED: "false",
      },
      options,
    );
    assert.deepStrictEqual(env, {
      HOME: "/home/ana",
      LANG: "pt_BR.UTF-8",
      ANTHROPIC_LOG: "debug",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/company-proxy.pem",
      J3_TELEMETRY_ENABLED: "false",
      PATH: "/home/ana/.local/bin:/usr/bin",
      J3_HOME: "/data/server/home",
      J3_HOST: "127.0.0.1",
      J3_WEB_CLIENT: "/opt/J3 Bots/resources/web/dist",
      J3_BROWSER_SERVER_HOST: "off",
    });
  });

  it("drops what would change how its Node runs, or which server settings it takes", () => {
    const env = serverEnvironment(
      {
        HOME: "/home/ana",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /tmp/hook.js",
        J3_HOME: "/home/ana/.j3-bots",
        J3_PORT: "3737",
        J3_WEB_CLIENT: "/tmp/elsewhere",
        APPIMAGE: "/home/ana/J3-Bots.AppImage",
        APPDIR: "/tmp/.mount_J3",
        npm_config_prefix: "/tmp/npm",
        Path: "C:\\Windows",
      },
      options,
    );
    assert.deepStrictEqual(Object.keys(env).sort(), [
      "HOME",
      "J3_BROWSER_SERVER_HOST",
      "J3_HOME",
      "J3_HOST",
      "J3_WEB_CLIENT",
      "PATH",
    ]);
    assert.strictEqual(env["J3_HOME"], "/data/server/home");
    assert.strictEqual(env["J3_WEB_CLIENT"], "/opt/J3 Bots/resources/web/dist");
  });
});

describe("where an export may not be written", () => {
  it.effect.skipIf(process.platform === "win32")(
    "inside the bots' home, by its own path or through a link to it, but beside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-holds-" });
        const home = path.join(root, "server", "home");
        yield* fs.makeDirectory(path.join(home, "bots"), { recursive: true });
        yield* fs.symlink(home, path.join(root, "shortcut"));
        assert.isTrue(yield* holdsFile(home, path.join(home, "export.tar.gz")));
        assert.isTrue(yield* holdsFile(home, path.join(home, "bots", "export.tar.gz")));
        assert.isTrue(yield* holdsFile(home, path.join(root, "shortcut", "export.tar.gz")));
        yield* fs.makeDirectory(path.join(home, "..exports"));
        assert.isTrue(yield* holdsFile(home, path.join(home, "..exports", "export.tar.gz")));
        assert.isFalse(yield* holdsFile(home, path.join(root, "server", "export.tar.gz")));
        assert.isFalse(yield* holdsFile(home, path.join(root, "home-2", "export.tar.gz")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
