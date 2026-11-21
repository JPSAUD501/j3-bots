// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { webAddress } from "./links.ts";

describe("webAddress", () => {
  it("keeps web addresses and refuses every other scheme", () => {
    expect(webAddress("https://github.com/settings/tokens")).toBe(
      "https://github.com/settings/tokens",
    );
    expect(webAddress("http://localhost:3000")).toBe("http://localhost:3000");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "tokens",
    ]) {
      expect(webAddress(url), url).toBeNull();
    }
  });
});
