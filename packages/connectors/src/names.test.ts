// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ConnectorSlug, MAX_TOOL_NAME, slugFor, toolName } from "./names.ts";

const slug = Schema.decodeSync(ConnectorSlug);
const CLAUDE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

describe("toolName", () => {
  it("joins the slug and the tool when the tool's name fits as it is", () => {
    expect(toolName(slug("linear"), "create_issue")).toBe("linear__create_issue");
  });

  it.each([
    ["dots", "files.read"],
    ["a double underscore", "a__b"],
    ["a long name", "x".repeat(120)],
    ["only symbols", "..."],
    ["a leading underscore", "_private"],
  ])("gives a tool whose name has %s a name every harness takes", (_, tool) => {
    const name = toolName(slug("my-files-connector-1"), tool);
    expect(`mcp__j3__${name}`).toMatch(CLAUDE_TOOL_NAME);
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(name.indexOf("__")).toBe("my-files-connector-1".length);
    expect(name.lastIndexOf("__")).toBe(name.indexOf("__"));
  });

  it("keeps two tools that clean to the same text apart", () => {
    expect(toolName(slug("fs"), "files.read")).not.toBe(toolName(slug("fs"), "files_read_"));
    expect(toolName(slug("fs"), `${"x".repeat(100)}a`)).not.toBe(
      toolName(slug("fs"), `${"x".repeat(100)}b`),
    );
  });

  it("refuses a slug that isn't short, lowercase and single-hyphened", () => {
    for (const bad of ["", "Linear", "a--b", "-a", "a_b", "x".repeat(21)]) {
      expect(Schema.is(ConnectorSlug)(bad)).toBe(false);
    }
  });
});

describe("slugFor", () => {
  it("makes a slug of the name, apart from those taken", () => {
    expect(slugFor("Google Drive", new Set())).toBe("google-drive");
    expect(slugFor("Notion — Équipe", new Set())).toBe("notion-equipe");
    expect(slugFor("日本", new Set())).toBe("connector");
    expect(slugFor("A very long connector name indeed", new Set(["a-very-long-connecto"]))).toBe(
      "a-very-long-connec-2",
    );
    expect(slugFor("Linear", new Set(["linear", "linear-2"]))).toBe("linear-3");
  });
});
