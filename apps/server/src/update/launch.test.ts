// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { SHELL_OVERRIDES } from "../config.ts";
import { systemdRunArgs } from "./launch.ts";

const plan = {
  id: "update_0123456789abcdefghjk",
  version: "0.4.0",
  command: "/home/op/.local/share/j3-bots/versions/0.3.1/bin/j3-bots",
  home: "/home/op/.j3-bots",
  searchPath: "/home/op/.local/bin:/usr/bin:/bin",
  release: { J3_RELEASE_BASE_URL: "http://127.0.0.1:8080/releases" },
};

/** The value of `--name=value` among `args`. */
const option = (args: ReadonlyArray<string>, name: string) =>
  args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));

describe("the update's transient unit", () => {
  it("is a unit of the user's manager, named after the run, and collected when it ends", () => {
    const args = systemdRunArgs(plan);
    assert.strictEqual(args[0], "--user");
    assert.deepStrictEqual(option(args, "unit"), ["j3-bots-update-0123456789abcdefghjk.service"]);
    assert.include(args, "--collect");
    assert.notInclude(args, "--scope");
  });

  it("runs the installed release's own update of exactly that version, for that run", () => {
    const args = systemdRunArgs(plan);
    const command = args.slice(args.indexOf("--") + 1);
    assert.deepStrictEqual(command, [
      plan.command,
      "update",
      "--version",
      "0.4.0",
      "--run",
      plan.id,
    ]);
  });

  it("gets the service's environment and nothing that would override its configuration", () => {
    const args = systemdRunArgs(plan);
    // The update downloads from where the server found the release.
    assert.deepStrictEqual(option(args, "setenv"), [
      `J3_HOME=${plan.home}`,
      `PATH=${plan.searchPath}`,
      "J3_RELEASE_BASE_URL=http://127.0.0.1:8080/releases",
    ]);
    assert.include(args, `--property=UnsetEnvironment=${SHELL_OVERRIDES.join(" ")}`);
    assert.deepStrictEqual(option(args, "working-directory"), [plan.home]);
  });

  it("gets no privilege beyond the user's", () => {
    const args = systemdRunArgs(plan);
    assert.include(args, "--property=NoNewPrivileges=yes");
  });

  it("passes a `$` in the command's path and the environment as it is, which systemd does not expand", () => {
    const args = systemdRunArgs({
      ...plan,
      command: "/opt/j3$HOME/${X}/bin/j3-bots",
      home: "/srv/$j3",
    });
    assert.strictEqual(args[args.indexOf("--") + 1], "/opt/j3$HOME/${X}/bin/j3-bots");
    assert.deepStrictEqual(option(args, "setenv")[0], "J3_HOME=/srv/$j3");
  });
});
