// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { isWithin } from "./paths.ts";

describe("isWithin", () => {
  it("takes a folder and what is in it, and nothing beside it", () => {
    assert.isTrue(isWithin("/home/sam/.j3-bots", "/home/sam/.j3-bots", "linux"));
    assert.isTrue(isWithin("/home/sam/.j3-bots", "/home/sam/.j3-bots/bots/b1", "linux"));
    assert.isTrue(isWithin("/", "/etc", "linux"));
    assert.isFalse(isWithin("/home/sam/.j3-bots", "/home/sam/.j3-bots-old", "linux"));
    assert.isFalse(isWithin("/home/sam/.j3-bots", "/home/sam", "linux"));
    assert.isFalse(isWithin("/home/sam/.j3-bots", "/home/sam/.J3-BOTS/bots", "linux"));
  });

  it("on Windows, separates by backslashes and compares without case", () => {
    const home = String.raw`C:\Users\Sam\AppData\Roaming\J3 Bots\server\home`;
    assert.isTrue(isWithin(home, String.raw`${home}\bots\b1`, "win32"));
    assert.isTrue(
      isWithin(home, String.raw`c:\users\sam\appdata\roaming\j3 bots\server\home\bots`, "win32"),
    );
    assert.isTrue(isWithin("C:\\", String.raw`C:\Users`, "win32"));
    assert.isFalse(isWithin(home, `${home}-old`, "win32"));
    assert.isFalse(isWithin(home, String.raw`C:\Users\Sam`, "win32"));
    assert.isFalse(
      isWithin(home, String.raw`D:\Users\Sam\AppData\Roaming\J3 Bots\server\home\bots`, "win32"),
    );
  });
});
