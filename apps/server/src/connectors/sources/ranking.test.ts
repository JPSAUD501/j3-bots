// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { owningDomain, rank } from "./ranking.ts";

it("credits a namespace's domain only with its own host and its subdomains", () => {
  assert.strictEqual(owningDomain("com.notion/mcp", "https://mcp.notion.com/mcp"), "notion.com");
  assert.strictEqual(
    owningDomain("com.figma.mcp/mcp", "https://mcp.figma.com/mcp"),
    "mcp.figma.com",
  );
  assert.strictEqual(owningDomain("app.linear/linear", "https://linear.app/mcp"), "linear.app");
  // Look-alike hosts.
  assert.isNull(owningDomain("com.notion/mcp", "https://mcp.notion.com.example.net/mcp"));
  assert.isNull(owningDomain("com.notion/mcp", "https://evilnotion.com/mcp"));
  // A wrapper of someone else's service, and a namespace that is no domain.
  assert.isNull(owningDomain("ai.wrapper/notion", "https://mcp.notion.com/mcp"));
  assert.isNull(owningDomain("notion/mcp", "https://notion/mcp"));
});

it("puts entries whose publisher owns their host first, then the closest names", () => {
  const entry = (name: string, owner: string | null) => ({ name, title: name, owner });
  const ranked = rank(
    [
      entry("ai.wrapper/notion-tools", null),
      entry("io.github.notionfan/tools", null),
      entry("ai.host/notion-proxy", "host.ai"),
      entry("com.notion/mcp", "notion.com"),
    ],
    "Notion",
  );
  assert.deepStrictEqual(
    ranked.map((result) => result.name),
    [
      "com.notion/mcp",
      "ai.host/notion-proxy",
      // The query is in its namespace, not only in its name.
      "io.github.notionfan/tools",
      "ai.wrapper/notion-tools",
    ],
  );
});
