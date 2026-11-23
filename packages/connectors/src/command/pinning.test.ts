// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { pinRefusal } from "./pinning.ts";

const refusal = (command: string) => {
  const [program = "", ...args] = command.split(" ");
  return Option.getOrNull(pinRefusal(program, args));
};

describe("pinRefusal", () => {
  it("runs a package fetched at an exact version", () => {
    for (const command of [
      "npx -y @modelcontextprotocol/server-filesystem@2025.8.21 /srv/notes",
      "npx --yes server-memory@1.2.3",
      "npx --package=@scope/tools@0.4.0-beta.1 tools-cli --port 3",
      "npx -p tools@1.0.0 -p helper@2.0.0 tools",
      "npm exec -- server@1.0.0 --flag",
      "npm exec --package=tools@1.0.0 -- tools-cli --port 3",
      "C:\\Program Files\\nodejs\\npx.cmd -y server@1.0.0",
      "uvx mcp-server-fetch==2025.4.7",
      "uvx --from mcp-server-git==0.6.2 mcp-server-git --repository /srv/repo",
      "uvx --with httpx==0.28.1,anyio==4.9.0 mcp-server-time@2025.1.1",
      "uv tool run --python 3.12 mcp-server-time==2025.1.1",
      "uv --quiet tool run mcp-server-time==2025.1.1",
      "npx server@1.2.3-beta.1+build.5",
    ]) {
      assert.isNull(refusal(command), command);
    }
  });

  it("refuses a package named with no version, a tag or a range", () => {
    for (const command of [
      "npx -y @modelcontextprotocol/server-filesystem /srv/notes",
      "npx server-memory@latest",
      "npx server-memory@^1.2.3",
      "npx -p tools tools-cli",
      "npx -p tools@1.0.0 -p helper tools",
      "npm x -- server@next",
      "npx github:someone/server",
      "npx ./server",
      "uvx mcp-server-fetch",
      "uvx mcp-server-fetch>=1.0",
      "uvx --from mcp-server-git mcp-server-git",
      "uvx --with httpx mcp-server-time==2025.1.1",
      "uv tool run mcp-server-time",
      "uv --quiet tool run mcp-server-time",
      "uv --directory /srv tool run mcp-server-time",
      // npm takes what is not a valid version for a tag.
      "npx server@1.2.3-..",
      // The file the path names, as the system reads it.
      "/usr/bin/npx/. server@latest",
      "/usr/lib/../bin/npx server@latest",
      "C:\\nodejs\\npx.cmd. server@latest",
    ]) {
      assert.strictEqual(refusal(command), "floating", command);
    }
  });

  it("refuses what it cannot read rather than guess which package runs", () => {
    assert.strictEqual(refusal("npx --unknown-option value server@1.0.0"), "unclear");
    assert.strictEqual(refusal("npx -y"), "unclear");
    assert.strictEqual(refusal("uvx --index"), "unclear");
    // npm exec reads `--package` after the package too, so it must follow `--`.
    assert.strictEqual(refusal("npm exec server@1.0.0 --package=other"), "unclear");
    assert.strictEqual(refusal("npm x server@1.0.0"), "unclear");
    // An option before npm's command may hide which command runs, as may one of uv's it does not know.
    assert.strictEqual(refusal("npm --yes exec server@latest"), "unclear");
    assert.strictEqual(refusal("uv --unknown x tool run mcp-server-time==1.0.0"), "unclear");
    assert.strictEqual(refusal("uv tool --quiet run mcp-server-time==1.0.0"), "unclear");
    // npm reads a prefix only one command has as that command, and init and create run a package.
    assert.strictEqual(refusal("npm exe server@latest"), "unclear");
    assert.strictEqual(refusal("npm init server"), "unclear");
    assert.strictEqual(refusal("npm create server@1.0.0"), "unclear");
    assert.strictEqual(refusal("npx -c tools@1.0.0"), "shell");
    assert.strictEqual(refusal("npm exec --call=anything"), "shell");
  });

  it("refuses a launcher's settings among the operator's variables, which can choose its package", () => {
    const pinned = ["-y", "server@1.0.0"];
    assert.strictEqual(
      Option.getOrNull(pinRefusal("npx", pinned, ["npm_config_package"])),
      "unclear",
    );
    assert.strictEqual(
      Option.getOrNull(pinRefusal("npx", pinned, ["NPM_CONFIG_REGISTRY"])),
      "unclear",
    );
    assert.strictEqual(
      Option.getOrNull(pinRefusal("uvx", ["server==1.0.0"], ["UV_INDEX_URL"])),
      "unclear",
    );
    assert.isNull(Option.getOrNull(pinRefusal("npx", pinned, ["API_KEY"])));
    assert.isNull(Option.getOrNull(pinRefusal("node", ["server.js"], ["npm_config_package"])));
  });

  it("runs any other program as it is given", () => {
    assert.isNull(refusal("node /srv/server.js"));
    assert.isNull(refusal("npm start"));
    assert.isNull(refusal("uv run server.py"));
    assert.isNull(refusal("uv --directory /srv/notes run server.py"));
  });
});
