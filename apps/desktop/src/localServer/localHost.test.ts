// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { serverEnvironment } from "./localHost.ts";

describe("the environment the server runs with", () => {
  const options = {
    path: "/home/ana/.local/bin:/usr/bin",
    home: "/data/server/home",
    host: "127.0.0.1",
    webClient: "/opt/J3 Bots/resources/web/dist",
  };

  it("keeps the operator's own variables and trusted certificates, and sets its PATH, home, address and web client", () => {
    const env = serverEnvironment(
      {
        HOME: "/home/ana",
        LANG: "pt_BR.UTF-8",
        ANTHROPIC_LOG: "debug",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/company-proxy.pem",
      },
      options,
    );
    assert.deepStrictEqual(env, {
      HOME: "/home/ana",
      LANG: "pt_BR.UTF-8",
      ANTHROPIC_LOG: "debug",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/company-proxy.pem",
      PATH: "/home/ana/.local/bin:/usr/bin",
      J3_HOME: "/data/server/home",
      J3_HOST: "127.0.0.1",
      J3_WEB_CLIENT: "/opt/J3 Bots/resources/web/dist",
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
      "J3_HOME",
      "J3_HOST",
      "J3_WEB_CLIENT",
      "PATH",
    ]);
    assert.strictEqual(env["J3_HOME"], "/data/server/home");
    assert.strictEqual(env["J3_WEB_CLIENT"], "/opt/J3 Bots/resources/web/dist");
  });
});
