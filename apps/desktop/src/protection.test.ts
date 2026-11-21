// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { protectionOf } from "./protection.ts";

const sealedAs = (version: string) => Buffer.concat([Buffer.from(version), Buffer.alloc(16, 7)]);

describe("how a sealed token is kept", () => {
  it("is encrypted on Linux only under a keyring's version", () => {
    expect(protectionOf(sealedAs("v11"), "linux")).toBe("encrypted");
    expect(protectionOf(sealedAs("v12"), "linux")).toBe("encrypted");
    for (const version of ["v10", "v13", "v1", ""]) {
      expect(protectionOf(sealedAs(version), "linux"), version).toBe("unencrypted");
    }
  });
});
