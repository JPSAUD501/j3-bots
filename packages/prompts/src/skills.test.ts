// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { sharedSkills } from "./skills.ts";

/**
 * The frontmatter harnesses list a skill by: a `name` of lowercase letters,
 * digits and hyphens, at most 64 characters, and a one-line `description` of
 * at most 1,024. A skill whose frontmatter breaks these is not offered to the
 * model at all.
 */
const FRONTMATTER = /^---\nname: ([^\n]*)\ndescription: ([^\n]*)\n---\n/;

describe("shared skills", () => {
  it("open with frontmatter a harness lists them by", () => {
    for (const skill of sharedSkills) {
      const match = FRONTMATTER.exec(skill.text);
      expect(match?.[1], skill.name).toBe(skill.name);
      expect(skill.name).toMatch(/^j3-[a-z0-9-]{1,61}$/);
      expect(match?.[2]?.length ?? 0).toBeGreaterThan(0);
      expect(match?.[2]?.length ?? 0).toBeLessThanOrEqual(1_024);
    }
  });

  it("carry no placeholder left to fill, j3-app's release included", () => {
    for (const skill of sharedSkills) expect(skill.text, skill.name).not.toMatch(/\{\{[^}]*\}\}/);
  });
});
