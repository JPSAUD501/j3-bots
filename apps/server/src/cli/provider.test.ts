// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { normalizeBaseUrl } from "./provider.ts";

it("takes the endpoint's root from what the operator typed, and refuses what is no base URL", () => {
  assert.deepStrictEqual(normalizeBaseUrl(" http://127.0.0.1:8317/v1/ "), {
    _tag: "url",
    url: "http://127.0.0.1:8317",
  });
  assert.deepStrictEqual(normalizeBaseUrl("http://[::1]:8317"), {
    _tag: "url",
    url: "http://[::1]:8317",
  });
  assert.deepStrictEqual(normalizeBaseUrl("https://proxy.lan/api"), {
    _tag: "url",
    url: "https://proxy.lan/api",
  });
  for (const refused of [
    "ftp://proxy.lan",
    "https://user:secret@proxy.lan",
    "https://proxy.lan/?key=secret",
    "proxy.lan:8317",
  ]) {
    assert.strictEqual(normalizeBaseUrl(refused)._tag, "problem", refused);
  }
});

it("refuses plain http to another machine, which would send the key in clear", () => {
  for (const remote of [
    "http://proxy.lan:8317",
    "http://192.168.1.20:8317",
    "http://example.com",
  ]) {
    const normalized = normalizeBaseUrl(remote);
    assert.strictEqual(normalized._tag, "problem", remote);
    if (normalized._tag === "problem") assert.include(normalized.problem, "https");
  }
});
