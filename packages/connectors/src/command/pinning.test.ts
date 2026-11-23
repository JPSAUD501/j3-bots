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
      "C:\\Program Files\\nodejs\\npx.cmd -y server@1.0.0",
      "uvx mcp-server-fetch==2025.4.7",
      "uvx --from mcp-server-git==0.6.2 mcp-server-git --repository /srv/repo",
      "uvx --with httpx==0.28.1,anyio==4.9.0 mcp-server-time@2025.1.1",
      "uv tool run --python 3.12 mcp-server-time==2025.1.1",
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
      "npm x server@next",
      "npx github:someone/server",
      "npx ./server",
      "uvx mcp-server-fetch",
      "uvx mcp-server-fetch>=1.0",
      "uvx --from mcp-server-git mcp-server-git",
      "uvx --with httpx mcp-server-time==2025.1.1",
      "uv tool run mcp-server-time",
    ]) {
      assert.strictEqual(refusal(command), "floating", command);
    }
  });

  it("refuses what it cannot read rather than guess which package runs", () => {
    assert.strictEqual(refusal("npx --unknown-option value server@1.0.0"), "unclear");
    assert.strictEqual(refusal("npx -y"), "unclear");
    assert.strictEqual(refusal("uvx --index"), "unclear");
    assert.strictEqual(refusal("npx -c tools@1.0.0"), "shell");
    assert.strictEqual(refusal("npm exec --call=anything"), "shell");
  });

  it("runs any other program as it is given", () => {
    assert.isNull(refusal("node /srv/server.js"));
    assert.isNull(refusal("npm start"));
    assert.isNull(refusal("uv run server.py"));
  });
});
