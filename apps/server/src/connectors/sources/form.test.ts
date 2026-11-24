// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { FieldKey } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { type ConnectForm, connectForm, contractFields, resolve } from "./form.ts";
import type { Remote } from "./serverJson.ts";

const formOf = (remote: Remote): ConnectForm => {
  const form = connectForm(remote);
  if (Result.isFailure(form)) throw new Error(`refused: ${form.failure}`);
  return form.success;
};

const values = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([key, value]) => [key, Redacted.make(value)]));

const filled = (form: ConnectForm, entries: Record<string, string>) => {
  const resolved = resolve(form, values(entries));
  if (Result.isFailure(resolved)) throw new Error(JSON.stringify(resolved.failure));
  return {
    url: Redacted.value(resolved.success.url),
    displayUrl: resolved.success.displayUrl,
    headers: resolved.success.headers.map((header) => [header.name, Redacted.value(header.value)]),
  };
};

const problems = (form: ConnectForm, entries: Record<string, string>) => {
  const resolved = resolve(form, values(entries));
  return Result.isFailure(resolved) ? resolved.failure : [];
};

describe("a remote's connect form", () => {
  it("asks for a secret header as a masked field, and sends what the operator typed", () => {
    const form = formOf({
      type: "streamable-http",
      url: "https://api.example.com/mcp/",
      headers: [
        { name: "Authorization", description: "A token", isSecret: true, isRequired: true },
      ],
    });
    assert.deepStrictEqual(contractFields(form), [
      {
        key: FieldKey.make("header:Authorization"),
        label: "Authorization",
        description: "A token",
        secret: true,
        required: true,
        placeholder: null,
        choices: [],
      },
    ]);
    assert.deepStrictEqual(filled(form, { "header:Authorization": "Bearer t0ken" }).headers, [
      ["Authorization", "Bearer t0ken"],
    ]);
    assert.deepStrictEqual(problems(form, {}), [{ _tag: "missing", key: "header:Authorization" }]);
  });

  it("fills a header's template, and asks for a variable its publisher did not declare", () => {
    // As one publisher writes it: a template whose variable has no declaration.
    const form = formOf({
      type: "streamable-http",
      url: "https://server.example.com/mcp",
      headers: [
        {
          name: "Authorization",
          value: "Bearer {api_key}",
          description: "The service's key",
          isSecret: true,
          isRequired: true,
        },
        {
          name: "X-Workspace",
          value: "ws-{workspace}",
          variables: { workspace: { description: "Which workspace" } },
        },
      ],
    });
    assert.deepStrictEqual(
      form.fields.map((field) => [field.key, field.secret, field.required, field.description]),
      [
        ["header:Authorization:api_key", true, true, "The service's key"],
        ["header:X-Workspace:workspace", false, false, "Which workspace"],
      ],
    );
    // An optional header whose variables are all left empty is not sent.
    assert.deepStrictEqual(filled(form, { "header:Authorization:api_key": "k" }).headers, [
      ["Authorization", "Bearer k"],
    ]);
    assert.deepStrictEqual(
      filled(form, { "header:Authorization:api_key": "k", "header:X-Workspace:workspace": "a" })
        .headers,
      [
        ["Authorization", "Bearer k"],
        ["X-Workspace", "ws-a"],
      ],
    );
  });

  it("asks for a URL's variables as plain fields, with their defaults and choices", () => {
    const form = formOf({
      type: "streamable-http",
      url: "https://{tenant}.example.com/{region}/mcp",
      variables: {
        tenant: { description: "Your tenant" },
        region: { default: "eu", choices: ["eu", "us"] },
      },
    });
    assert.deepStrictEqual(
      contractFields(form).map((field) => [
        field.key,
        field.required,
        field.placeholder,
        field.choices,
      ]),
      [
        ["url:tenant", true, null, []],
        // A default makes it optional: left empty, it takes the default, which shows as its placeholder.
        ["url:region", false, "eu", ["eu", "us"]],
      ],
    );
    assert.strictEqual(
      filled(form, { "url:tenant": "acme" }).url,
      "https://acme.example.com/eu/mcp",
    );
    assert.deepStrictEqual(problems(form, { "url:tenant": "acme", "url:region": "ap" }), [
      { _tag: "not-a-choice", key: "url:region" },
    ]);
    // A value cannot leave the part of the address it fills.
    assert.deepStrictEqual(problems(form, { "url:tenant": "evil.example/x" }), [
      { _tag: "invalid", key: "url:tenant" },
    ]);
  });

  it("keeps a secret part of the address out of the address it shows", () => {
    const form = formOf({
      type: "streamable-http",
      url: "https://mcp.example.com/{key}/mcp",
      variables: { key: { isSecret: true } },
    });
    const { url, displayUrl } = filled(form, { "url:key": "s3cret" });
    assert.strictEqual(url, "https://mcp.example.com/s3cret/mcp");
    assert.strictEqual(displayUrl, "https://mcp.example.com/{key}/mcp");
    // Nor a path segment.
    assert.strictEqual(
      filled(form, { "url:key": "a/../../admin?x=" }).url,
      "https://mcp.example.com/a%2F..%2F..%2Fadmin%3Fx%3D/mcp",
    );
  });

  it("refuses a value that would break its header, and a field the form does not have", () => {
    const form = formOf({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "X-Api-Key", isSecret: true, isRequired: true }],
    });
    assert.deepStrictEqual(
      problems(form, { "header:X-Api-Key": "k\r\nX-Other: 1", "header:Host": "evil" }),
      [
        { _tag: "unknown", key: "header:Host" },
        { _tag: "invalid", key: "header:X-Api-Key" },
      ],
    );
  });

  it("is not offered for a remote J3 Bots cannot connect safely", () => {
    const refusal = (remote: Remote) => {
      const form = connectForm(remote);
      return Result.isFailure(form) ? form.failure : "offered";
    };
    const url = "https://mcp.example.com/mcp";
    assert.strictEqual(refusal({ type: "sse", url }), "not-streamable-http");
    assert.strictEqual(
      refusal({ type: "streamable-http", url: "http://mcp.example.com/mcp" }),
      "not-https",
    );
    assert.strictEqual(
      refusal({ type: "streamable-http", url: "https://user:pw@mcp.example.com/mcp" }),
      "not-https",
    );
    assert.strictEqual(
      refusal({ type: "streamable-http", url, headers: [{ name: "Host", value: "internal" }] }),
      "reserved-header",
    );
    assert.strictEqual(
      refusal({ type: "streamable-http", url, headers: [{ name: "X-A: b", isSecret: true }] }),
      "bad-header",
    );
    assert.strictEqual(
      refusal({ type: "streamable-http", url, headers: [{ name: "X-A", value: "a\r\nHost: b" }] }),
      "control-character",
    );
  });

  it("shows a publisher's description as plain text, without characters that reverse it, cut short", () => {
    const form = formOf({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "X-Key", isSecret: true, description: `Paste‮ your\n\tkey ${"x".repeat(400)}` },
      ],
    });
    const [field] = form.fields;
    assert.isDefined(field?.description);
    const description = field?.description ?? "";
    assert.isTrue(description.startsWith("Paste your key xxx"));
    assert.strictEqual(description.length, 300);
    assert.isTrue(description.endsWith("…"));
  });
});
