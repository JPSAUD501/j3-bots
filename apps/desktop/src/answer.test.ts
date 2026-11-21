// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { bodyCollector, responseOf } from "./answer.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("responseOf", () => {
  it("keeps a 200's body", async () => {
    const answer = responseOf(200, bytes('{"ok":true}'));
    expect(Result.isSuccess(answer)).toBe(true);
    if (Result.isSuccess(answer)) expect(await answer.success.text()).toBe('{"ok":true}');
  });

  it("answers any other status with its status alone", async () => {
    const answer = responseOf(302, bytes("moved"));
    expect(Result.isSuccess(answer)).toBe(true);
    if (Result.isSuccess(answer)) {
      expect(answer.success.status).toBe(302);
      expect(answer.success.body).toBeNull();
    }
  });

  it("fails for a status a Response cannot have, instead of throwing", () => {
    expect(Result.isFailure(responseOf(101, null))).toBe(true);
    expect(Result.isFailure(responseOf(600, null))).toBe(true);
  });
});

describe("bodyCollector", () => {
  it("collects a body up to the limit and refuses one past it", () => {
    const body = bodyCollector(8);
    expect(body.add(bytes("1234"))).toBe(true);
    expect(body.add(bytes("5678"))).toBe(true);
    expect(new TextDecoder().decode(body.bytes())).toBe("12345678");
    expect(body.add(bytes("9"))).toBe(false);
  });
});
