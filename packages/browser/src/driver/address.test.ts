// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { addressOf } from "./address.ts";

it("opens web addresses, adds the scheme a bare host needs, and refuses other schemes", () => {
  assert.strictEqual(addressOf("https://example.test/a?b"), "https://example.test/a?b");
  assert.strictEqual(addressOf("example.test/docs"), "https://example.test/docs");
  assert.strictEqual(addressOf("example.test:8443"), "https://example.test:8443/");
  assert.strictEqual(addressOf("localhost:5173/app"), "http://localhost:5173/app");
  assert.strictEqual(addressOf("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.strictEqual(addressOf("file:///etc/passwd"), undefined);
  assert.strictEqual(addressOf("javascript:alert(1)"), undefined);
  assert.strictEqual(addressOf("chrome://settings"), undefined);
});
