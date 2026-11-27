// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { withoutBrowserAccess } from "./Settings.ts";

describe("withoutBrowserAccess", () => {
  it("keeps a project's other overrides, and removes a set left empty", () => {
    expect(withoutBrowserAccess({ enableAgentBrowserAccess: true, model: "m" })).toEqual({
      model: "m",
    });
    expect(withoutBrowserAccess({ enableAgentBrowserAccess: false })).toBeNull();
    expect(withoutBrowserAccess({ model: "m" })).toBeUndefined();
  });
});
