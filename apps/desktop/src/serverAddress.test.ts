// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { parseServerAddress } from "./serverAddress.ts";

const parsed = (typed: string) => {
  const result = parseServerAddress(typed);
  return Result.isSuccess(result) ? result.success : `refused: ${result.failure}`;
};

describe("the server address the operator types", () => {
  it("names the server's origin, plain HTTP for a private address and HTTPS otherwise", () => {
    assert.strictEqual(parsed("192.0.2.10:3737"), "https://192.0.2.10:3737");
    assert.strictEqual(parsed(" 192.168.1.20:3737 "), "http://192.168.1.20:3737");
    assert.strictEqual(parsed("10.0.0.5:3737/"), "http://10.0.0.5:3737");
    assert.strictEqual(parsed("100.72.9.41:3737"), "http://100.72.9.41:3737");
    assert.strictEqual(parsed("127.0.0.1:3737"), "http://127.0.0.1:3737");
    assert.strictEqual(parsed("localhost:3737"), "http://localhost:3737");
    assert.strictEqual(parsed("[::1]:3737"), "http://[::1]:3737");
    assert.strictEqual(parsed("[fd00::5]:3737"), "http://[fd00::5]:3737");
    assert.strictEqual(parsed("j3.example.test"), "https://j3.example.test");
    assert.strictEqual(parsed("HTTPS://J3.Example.test:8443"), "https://j3.example.test:8443");
    assert.strictEqual(parsed("http://192.168.1.20:3737"), "http://192.168.1.20:3737");
  });

  it("refuses plain HTTP that would cross a network the operator does not own", () => {
    assert.strictEqual(parsed("http://j3.example.test"), "refused: needs-https");
    assert.strictEqual(parsed("http://192.0.2.10:3737"), "refused: needs-https");
    assert.strictEqual(parsed("http://nas.local:3737"), "refused: needs-https");
  });

  it("refuses what is not a server's origin", () => {
    for (const typed of [
      "",
      "   ",
      "http://192.168.1.20:3737/api",
      "192.168.1.20:3737?x=1",
      "https://j3.example.test/#top",
      "https://user:secret@j3.example.test",
      "ftp://192.168.1.20",
      "file:///home",
      "j3bots://app",
      "http://",
      "not an address",
    ]) {
      assert.strictEqual(parsed(typed), "refused: invalid", typed);
    }
  });
});
