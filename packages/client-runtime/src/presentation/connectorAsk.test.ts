// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { ownAppClient } from "./connectorAsk.ts";

describe("ownAppClient", () => {
  it("takes the ID as typed around it, and no secret when none is given", () => {
    expect(ownAppClient("  app-1.apps.example \n", "")).toEqual({
      _tag: "valid",
      client: { clientId: "app-1.apps.example", clientSecret: null },
    });
  });

  it("keeps a secret redacted and exactly as typed", () => {
    const typed = ownAppClient("app-1", " s3cret ");
    if (typed._tag !== "valid" || typed.client.clientSecret === null) {
      return expect.unreachable();
    }
    expect(Redacted.value(typed.client.clientSecret)).toBe(" s3cret ");
    expect(String(typed.client.clientSecret)).not.toContain("s3cret");
  });

  it("names the field the server would refuse", () => {
    expect(ownAppClient("   ", "s3cret")).toEqual({ _tag: "invalid", problem: "client-id" });
    expect(ownAppClient("app-1", "line one\nline two")).toEqual({
      _tag: "invalid",
      problem: "client-secret",
    });
  });
});
