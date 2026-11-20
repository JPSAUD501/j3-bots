// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { editToml, type TomlEdit, tomlString } from "./toml.ts";

/** Replaces `[mcp_servers.j3]`, as provisioning does. */
const tools: TomlEdit = {
  keys: [],
  owns: [["mcp_servers", "j3"]],
  tables: [{ path: ["mcp_servers", "j3"], values: [["command", "/usr/bin/node"]] }],
};

const edited = (text: string, edit: TomlEdit = tools) => {
  const result = editToml(text, edit);
  assert.strictEqual(result._tag, "edited");
  return result._tag === "edited" ? result.text : "";
};

describe("editToml", () => {
  it("keeps a table whose quoted name holds a ]", () => {
    const text = [
      "[mcp_servers.j3]",
      'command = "/old/node"',
      "",
      '[projects."/tmp/J3 [test]/bots/ana"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    assert.strictEqual(
      edited(text),
      [
        "[mcp_servers.j3]",
        'command = "/usr/bin/node"',
        "",
        '[projects."/tmp/J3 [test]/bots/ana"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
  });

  it("does not take a line inside a multi-line string for a table", () => {
    const text = [
      'notes = """',
      "[mcp_servers.j3]",
      'command = "/old/node"',
      '"""',
      "",
      "[mcp_servers.j3]",
      'command = "/old/node"',
      "",
    ].join("\n");
    assert.strictEqual(
      edited(text),
      [
        'notes = """',
        "[mcp_servers.j3]",
        'command = "/old/node"',
        '"""',
        "",
        "[mcp_servers.j3]",
        'command = "/usr/bin/node"',
        "",
      ].join("\n"),
    );
  });

  it("replaces an owned table however the file writes it", () => {
    const text = [
      'mcp_servers.j3.command = "/old/node"',
      'model = "gpt-6-luna"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const result = edited(text);
    assert.notInclude(result, "/old/node");
    assert.include(result, 'model = "gpt-6-luna"');
    assert.include(result, '[mcp_servers.other]\ncommand = "other"');
    assert.include(result, 'command = "/usr/bin/node"');
  });

  it("edits J3 Bots' table inside an inline table, keeping the other pairs as written", () => {
    const text = [
      'mcp_servers = { j3 = { command = "/old/node" }, other = { command = "other", args = ["a, b"] } } # tools',
      "",
      "[projects.x]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const result = edited(text);
    assert.strictEqual(
      result.split("\n")[0],
      'mcp_servers = { other = { command = "other", args = ["a, b"] }, j3 = { command = "/usr/bin/node" } } # tools',
    );
    assert.notInclude(result, "[mcp_servers.j3]");
    // Provisioned again, it reads the same.
    assert.strictEqual(edited(result), result);
  });

  it("refuses a value J3 Bots' table would go under, naming its line", () => {
    const result = editToml('model = "gpt-6-luna"\nmcp_servers = "the-secret"\n', tools);
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag === "unreadable") {
      assert.include(result.reason, "mcp_servers on line 2");
      assert.notInclude(result.reason, "the-secret");
    }
  });

  it("keeps the operator's comments above a table it replaces", () => {
    const text = [
      'model = "gpt-6-luna"',
      "",
      "# The bot tools; J3 Bots rewrites this table.",
      "[mcp_servers.j3]",
      'command = "/old/node"',
      "",
    ].join("\n");
    assert.strictEqual(
      edited(text),
      [
        'model = "gpt-6-luna"',
        "",
        "# The bot tools; J3 Bots rewrites this table.",
        "[mcp_servers.j3]",
        'command = "/usr/bin/node"',
        "",
      ].join("\n"),
    );
  });

  it("leaves a file that is not TOML as it is, and says where without quoting it", () => {
    const result = editToml('key = "the-secret\n[mcp_servers.j3]\n', tools);
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag === "unreadable") {
      assert.match(result.reason, /line \d+, column \d+/);
      assert.notInclude(result.reason, "the-secret");
    }
  });
});

describe("tomlString", () => {
  it("escapes what TOML would read otherwise, and makes lone surrogates whole", () => {
    assert.strictEqual(tomlString('a "b"\n\\c\u007f'), '"a \\"b\\"\\n\\\\c\\u007f"');
    assert.strictEqual(tomlString("\ud800"), '"�"');
  });
});
