// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { searchFor, typedAddress } from "./address.ts";

describe("what the address bar opens", () => {
  it("opens addresses, with the scheme added when it was left out", () => {
    assert.strictEqual(typedAddress("example.com"), "https://example.com/");
    assert.strictEqual(typedAddress(" http://example.com/a?b "), "http://example.com/a?b");
    assert.strictEqual(typedAddress("localhost:5173/x"), "http://localhost:5173/x");
    assert.strictEqual(typedAddress("http://intranet"), "http://intranet/");
  });

  it("searches for words, and for one word that is no host", () => {
    assert.strictEqual(typedAddress("pão de queijo"), searchFor("pão de queijo"));
    assert.strictEqual(typedAddress("queijo"), searchFor("queijo"));
    assert.strictEqual(typedAddress("file:///etc/passwd"), searchFor("file:///etc/passwd"));
    assert.strictEqual(
      new URL(searchFor("a&b")).searchParams.get("q"),
      "a&b",
      "the words are the query's, not its syntax",
    );
  });
});
