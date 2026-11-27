// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { accountPatch, noAccountEdits } from "./accountSetup.ts";

const setup = {
  enabled: true,
  added: true,
  binaryPath: null,
  launchArguments: "",
  home: "/srv/j3/providers/claude-code_work",
};

describe("accountPatch", () => {
  it("sends only what changed, and says when the change ends what the account runs", () => {
    expect(accountPatch("Work", setup, { ...noAccountEdits, name: " Work " })).toEqual({
      _tag: "unchanged",
    });
    expect(accountPatch("Work", setup, { ...noAccountEdits, name: "Personal" })).toEqual({
      _tag: "changes",
      changes: { name: "Personal" },
      rebuild: false,
    });
    expect(
      accountPatch("Work", setup, {
        ...noAccountEdits,
        binaryPath: " /opt/claude/bin/claude ",
        launchArguments: "--chrome",
      }),
    ).toEqual({
      _tag: "changes",
      changes: { binaryPath: "/opt/claude/bin/claude", launchArguments: "--chrome" },
      rebuild: true,
    });
  });

  it("clears a chosen executable when its field is emptied", () => {
    const chosen = { ...setup, binaryPath: "/opt/claude/bin/claude" };
    expect(accountPatch("Work", chosen, { ...noAccountEdits, binaryPath: "  " })).toEqual({
      _tag: "changes",
      changes: { binaryPath: null },
      rebuild: true,
    });
  });

  it("refuses an empty name, a path that is not absolute, and arguments on two lines", () => {
    expect(
      accountPatch("Work", setup, {
        name: " ",
        binaryPath: "bin/claude",
        launchArguments: "--a\n--b",
      }),
    ).toEqual({
      _tag: "invalid",
      fields: new Set(["name", "binaryPath", "launchArguments"]),
    });
    expect(
      accountPatch("Work", setup, { ...noAccountEdits, binaryPath: "C:\\Tools\\claude.exe" }),
    ).toMatchObject({ _tag: "changes" });
  });
});
