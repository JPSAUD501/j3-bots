// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { BotTemplate, templatePermissionMode } from "./template.ts";

const valid = {
  format: "j3-bots/bot-template",
  version: 1,
  profile: { name: "Scout", title: "", avatar: { shape: "bean", color: "honey" }, job: "" },
  model: { providerId: "claude", modelId: "opus" },
  permissionMode: "auto",
  skills: [{ name: "triage", text: "Read each message." }],
  routines: [],
};

const decode = Schema.decodeUnknownOption(BotTemplate);
const accepts = (template: object) => decode(template)._tag === "Some";
const withSkills = (skills: ReadonlyArray<{ readonly name: string; readonly text: string }>) =>
  accepts({ ...valid, skills });

describe("BotTemplate", () => {
  it("takes a skill only under a name that stays in the skills folder", () => {
    assert.isTrue(withSkills([{ name: "inbox-triage-2", text: "Steps." }]));
    for (const name of [
      "../memory",
      "a/b",
      ".hidden",
      "Triage",
      "-lead",
      "trail-",
      "",
      "a".repeat(65),
    ]) {
      assert.isFalse(withSkills([{ name, text: "Steps." }]), name);
    }
  });

  it("refuses two skills under one name", () => {
    assert.isFalse(
      withSkills([
        { name: "triage", text: "One." },
        { name: "triage", text: "Two." },
      ]),
    );
  });

  it("refuses a file of another kind or a later version", () => {
    assert.isTrue(accepts(valid));
    assert.isFalse(accepts({ ...valid, format: "something-else" }));
    assert.isFalse(accepts({ ...valid, version: 2 }));
  });
});

describe("templatePermissionMode", () => {
  it("keeps the template's mode only while the default allows as much", () => {
    assert.strictEqual(templatePermissionMode("full-access", "auto"), "auto");
    assert.strictEqual(templatePermissionMode("auto-accept-edits", "auto"), "auto-accept-edits");
    assert.strictEqual(templatePermissionMode("auto", "supervised"), "supervised");
    assert.strictEqual(templatePermissionMode("unknown", "auto"), "supervised");
  });
});
