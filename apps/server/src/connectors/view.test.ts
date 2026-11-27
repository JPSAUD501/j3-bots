// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { ServedSkill } from "@j3-bots/connectors";
import * as Option from "effect/Option";
import { NOTHING_SEEN, type Seen, servedUnlisted, skillsOffered } from "./view.ts";

/**
 * A connector's skills as a sign-in left them (decision 0089): a listing is
 * the account's that read it, and is never offered under another.
 */

const skill = (name: string): ServedSkill => {
  const uri = `skill://${name}/SKILL.md`;
  return {
    uri,
    name,
    description: `The ${name} skill.`,
    files: null,
    tooLarge: false,
    entry: { uri, frontmatter: { name, description: `The ${name} skill.` }, resources: "dynamic" },
  };
};

/** A connector whose server listed `invoices` while `listedUnder` signed its requests, seen as `signing` signs them now. */
const seen = (listedUnder: number, signing: number): Seen => ({
  ...NOTHING_SEEN,
  served: Option.some({
    info: {
      protocolVersion: "2026-07-28",
      name: null,
      version: null,
      offers: { tools: true, resources: true, prompts: false, tasks: false, skills: true },
    },
    resources: [],
    prompts: [],
    skills: { skills: [skill("invoices")], until: Number.MAX_SAFE_INTEGER, signing: listedUnder },
  }),
  signing,
});

describe("a connector's skills across sign-ins", () => {
  it("offers a listing only under the sign-in that read it, and lists it again under another", () => {
    assert.deepStrictEqual(
      skillsOffered(seen(2, 2)).map((one) => one.name),
      ["invoices"],
    );
    assert.isFalse(servedUnlisted(seen(2, 2)));
    assert.deepStrictEqual(skillsOffered(seen(2, 3)), []);
    assert.isTrue(servedUnlisted(seen(2, 3)));
  });
});
