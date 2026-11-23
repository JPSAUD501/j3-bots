// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_CREDENTIAL_ORIGINS } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { typedOrigins } from "./vault.ts";

describe("typedOrigins", () => {
  it("takes each line's site as its origin, once", () => {
    expect(
      typedOrigins(
        "https://example.com/login\n  accounts.example.com \n\nhttps://example.com\nhttp://127.0.0.1:8080/x",
      ),
    ).toEqual(
      Option.some(["https://example.com", "https://accounts.example.com", "http://127.0.0.1:8080"]),
    );
  });

  it("refuses a line that names no site, none at all, and too many", () => {
    expect(typedOrigins("https://example.com\nftp://example.com")).toEqual(Option.none());
    expect(typedOrigins(" \n ")).toEqual(Option.none());
    const many = Array.from(
      { length: MAX_CREDENTIAL_ORIGINS + 1 },
      (_, index) => `https://s${index}.example.com`,
    );
    expect(typedOrigins(many.join("\n"))).toEqual(Option.none());
  });
});
