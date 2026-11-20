// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { normalizeBaseUrl } from "./provider.ts";

it("takes the endpoint's root from what the operator typed, and refuses what is no base URL", () => {
  assert.deepStrictEqual(
    normalizeBaseUrl(" http://127.0.0.1:8317/v1/ "),
    Option.some("http://127.0.0.1:8317"),
  );
  assert.deepStrictEqual(
    normalizeBaseUrl("https://proxy.lan/api"),
    Option.some("https://proxy.lan/api"),
  );
  for (const refused of [
    "ftp://proxy.lan",
    "http://user:secret@proxy.lan",
    "http://proxy.lan/?key=secret",
    "proxy.lan:8317",
  ]) {
    assert.isTrue(Option.isNone(normalizeBaseUrl(refused)), refused);
  }
});
