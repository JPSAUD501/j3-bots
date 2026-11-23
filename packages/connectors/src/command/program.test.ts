// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { interpreterReads } from "./program.ts";

describe("interpreterReads", () => {
  const npx = String.raw`C:\Program Files\nodejs\npx.cmd`;

  it("lets a batch file have plain arguments, spaces and paths among them", () => {
    assert.isFalse(
      interpreterReads("win32", npx, ["-y", "server@1.0.0", String.raw`C:\Users\Sam Lee\notes`]),
    );
  });

  it("refuses an argument Windows' command interpreter would read as more than text", () => {
    for (const arg of ['say "hi"', "%PATH%", "a&calc", "x|y", "(a)", "a^b", "!v!", "line\nbreak"]) {
      assert.isTrue(interpreterReads("win32", npx, [arg]), arg);
    }
  });

  it("leaves any other program, and any other platform, alone", () => {
    assert.isFalse(interpreterReads("win32", String.raw`C:\Tools\server.exe`, ["a&b"]));
    assert.isFalse(interpreterReads("linux", "/usr/bin/npx.cmd", ["a&b"]));
  });
});
