// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { normalizeBaseUrl, providerBaseUrlProblem } from "./provider.ts";

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
  // The URL the server checks and the engine is given is the one the parser reads.
  assert.deepStrictEqual(normalizeBaseUrl("HTTPS://Proxy.LAN:443/a/../api/v1/"), {
    _tag: "url",
    url: "https://proxy.lan/api",
  });
  for (const refused of [
    "ftp://proxy.lan",
    "https://user:secret@proxy.lan",
    "https://proxy.lan/?key=secret",
    // Empty delimiters the parser drops, after which a harness's `/v1` would land.
    "https://proxy.lan?",
    "https://proxy.lan/api#",
    "proxy.lan:8317",
  ]) {
    const normalized = normalizeBaseUrl(refused);
    assert.strictEqual(normalized._tag, "problem", refused);
    if (normalized._tag === "problem") assert.notInclude(normalized.problem, "secret");
  }
});

it("takes only a base URL in its base form from a client, as the CLI sends it", () => {
  assert.isUndefined(providerBaseUrlProblem("https://proxy.lan/api"));
  for (const refused of [
    "https://Proxy.lan",
    "https://proxy.lan:443",
    "https://proxy.lan/a/../b",
  ]) {
    assert.isDefined(providerBaseUrlProblem(refused), refused);
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
