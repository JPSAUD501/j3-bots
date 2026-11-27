// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { MAX_ATTACHMENT_NAME_LENGTH } from "@j3-bots/contracts";
import { freeName, savedName } from "./files.ts";

describe("the names of the browser's downloads", () => {
  it("keeps a site's name out of other folders", () => {
    assert.strictEqual(savedName("../../.bashrc"), "_.._.bashrc");
    assert.strictEqual(savedName(".."), "download");
    assert.strictEqual(savedName("report\u0000.pdf"), "report.pdf");
  });

  it("shortens a long name and keeps its extension", () => {
    const name = savedName(`${"a".repeat(400)}.tar.gz`);
    assert.strictEqual(name.length, MAX_ATTACHMENT_NAME_LENGTH);
    assert.isTrue(name.endsWith(".gz"));
  });

  it("numbers a second file of the same name", () => {
    const taken = new Set(["report.pdf", "report (2).pdf"]);
    assert.strictEqual(
      freeName("report.pdf", (name) => taken.has(name)),
      "report (3).pdf",
    );
    assert.strictEqual(
      freeName("notes", (name) => name === "notes"),
      "notes (2)",
    );
  });
});
