// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { powerShellLiteral } from "@j3-bots/processes";
import {
  createPrivateFolder,
  type FolderAcl,
  judgeAcl,
  judgeWriteAcl,
  readFolderAcl,
  readFolderAcls,
  repairCommand,
} from "./windowsAcl.ts";
import { openToOthers, runInPowerShell } from "./testPrivacy.ts";

const USER = "S-1-5-21-1000000001-1000000002-1000000003-1001";
const ANOTHER_USER = "S-1-5-21-1000000001-1000000002-1000000003-1002";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const EVERYONE = "S-1-1-0";
const CREATOR_OWNER = "S-1-3-0";
const AUTHENTICATED_USERS = "S-1-5-11";
const GUESTS = "S-1-5-32-546";

const FULL_CONTROL = 0x1f01ff;
const MODIFY = 0x301bf;
const READ_AND_EXECUTE = 0x1200a9;
const WRITE_DATA = 0x2;
const GENERIC_ALL = 0x10000000;

type Rule = FolderAcl["rules"][number];

const rule = (sid: string, rights: number, options: Partial<Rule> = {}): Rule => ({
  sid,
  allow: true,
  rights,
  inherited: false,
  inheritOnly: false,
  ...options,
});

/** What the desktop's home gets: inheritance off, full control for this user, SYSTEM and Administrators. */
const privateAcl: FolderAcl = {
  user: USER,
  groups: [EVERYONE, USERS, AUTHENTICATED_USERS],
  owner: USER,
  protected: true,
  rules: [rule(USER, FULL_CONTROL), rule(SYSTEM, FULL_CONTROL), rule(ADMINISTRATORS, FULL_CONTROL)],
};

const withRules = (...rules: ReadonlyArray<Rule>): FolderAcl => ({
  ...privateAcl,
  rules: [...privateAcl.rules, ...rules],
});

describe("judgeAcl", () => {
  it("takes the list the home is created with, and the one a profile folder inherits", () => {
    assert.strictEqual(judgeAcl(privateAcl), "private");
    assert.strictEqual(
      judgeAcl({
        ...privateAcl,
        protected: false,
        rules: privateAcl.rules.map((granted) => ({ ...granted, inherited: true })),
      }),
      "private",
    );
  });

  it("takes a folder owned by SYSTEM or the Administrators, who own what they want to anyway", () => {
    assert.strictEqual(judgeAcl({ ...privateAcl, owner: SYSTEM }), "private");
    assert.strictEqual(judgeAcl({ ...privateAcl, owner: ADMINISTRATORS }), "private");
  });

  it("refuses a folder another user owns", () => {
    assert.strictEqual(judgeAcl({ ...privateAcl, owner: ANOTHER_USER }), "not-owned");
  });

  it("refuses a folder any other account may open, whatever the rights", () => {
    assert.strictEqual(
      judgeAcl(withRules(rule(USERS, READ_AND_EXECUTE, { inherited: true }))),
      "open-to-others",
    );
    assert.strictEqual(judgeAcl(withRules(rule(EVERYONE, WRITE_DATA))), "open-to-others");
    assert.strictEqual(judgeAcl(withRules(rule(ANOTHER_USER, FULL_CONTROL))), "open-to-others");
  });

  it("refuses a rule that reaches only what is inside the folder, which is what the folder holds", () => {
    assert.strictEqual(
      judgeAcl(withRules(rule(USERS, READ_AND_EXECUTE, { inheritOnly: true }))),
      "open-to-others",
    );
  });

  it("is not opened by a rule that denies, nor by one for whoever creates a file there", () => {
    assert.strictEqual(
      judgeAcl(withRules(rule(GUESTS, FULL_CONTROL, { allow: false }))),
      "private",
    );
    assert.strictEqual(
      judgeAcl(withRules(rule(CREATOR_OWNER, FULL_CONTROL, { inheritOnly: true }))),
      "private",
    );
  });

  it("is closed to its owner by a rule that denies one of the user's groups", () => {
    assert.strictEqual(
      judgeAcl(withRules(rule(EVERYONE, WRITE_DATA, { allow: false }))),
      "closed-to-owner",
    );
    assert.strictEqual(
      judgeAcl(withRules(rule(USERS, FULL_CONTROL, { allow: false }))),
      "closed-to-owner",
    );
  });

  it("does not count a grant that reaches the user only through a group", () => {
    assert.strictEqual(
      judgeAcl({
        ...privateAcl,
        groups: [...privateAcl.groups, ADMINISTRATORS],
        rules: [rule(ADMINISTRATORS, FULL_CONTROL)],
      }),
      "closed-to-owner",
    );
  });

  it("refuses a folder this user may not modify, and one where a rule denies what it needs", () => {
    const only = (...rules: ReadonlyArray<Rule>): FolderAcl => ({ ...privateAcl, rules });
    assert.strictEqual(
      judgeAcl(only(rule(USER, READ_AND_EXECUTE), rule(SYSTEM, FULL_CONTROL))),
      "closed-to-owner",
    );
    assert.strictEqual(judgeAcl(only(rule(SYSTEM, FULL_CONTROL))), "closed-to-owner");
    assert.strictEqual(
      judgeAcl(withRules(rule(USER, WRITE_DATA, { allow: false }))),
      "closed-to-owner",
    );
    // A grant that reaches only what is inside does not let the user into the folder itself.
    assert.strictEqual(
      judgeAcl(only(rule(USER, FULL_CONTROL, { inheritOnly: true }))),
      "closed-to-owner",
    );
  });

  it("reads generic rights for what they mean, also when PowerShell gives them as a negative number", () => {
    const only = (rights: number): FolderAcl => ({ ...privateAcl, rules: [rule(USER, rights)] });
    assert.strictEqual(judgeAcl(only(GENERIC_ALL)), "private");
    assert.strictEqual(judgeAcl(only(MODIFY)), "private");
    // GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE, past 2^31, as a signed 32-bit number.
    assert.strictEqual(judgeAcl(only(0xe0010000 | 0)), "private");
    // Without DELETE, the generic rights do not add up to Modify.
    assert.strictEqual(judgeAcl(only(0xe0000000 | 0)), "closed-to-owner");
    assert.strictEqual(judgeAcl(only(0x80000000 | 0)), "closed-to-owner");
  });
});

describe("judgeWriteAcl", () => {
  it("takes a folder others may read and run from, as an install folder on Unix", () => {
    assert.strictEqual(judgeWriteAcl(privateAcl), "own");
    assert.strictEqual(judgeWriteAcl(withRules(rule(USERS, READ_AND_EXECUTE))), "own");
    assert.strictEqual(judgeWriteAcl({ ...privateAcl, owner: ADMINISTRATORS }), "own");
  });

  it("refuses a folder another user owns", () => {
    assert.strictEqual(judgeWriteAcl({ ...privateAcl, owner: ANOTHER_USER }), "not-owned");
  });

  it("refuses a folder another account may write in, also only in what is made inside it, or through generic rights", () => {
    assert.strictEqual(judgeWriteAcl(withRules(rule(USERS, WRITE_DATA))), "writable-by-others");
    assert.strictEqual(
      judgeWriteAcl(withRules(rule(AUTHENTICATED_USERS, MODIFY, { inheritOnly: true }))),
      "writable-by-others",
    );
    assert.strictEqual(judgeWriteAcl(withRules(rule(EVERYONE, GENERIC_ALL))), "writable-by-others");
  });

  it("is not opened to writing by a rule that denies, nor by one for whoever creates a file there", () => {
    assert.strictEqual(
      judgeWriteAcl(withRules(rule(USERS, FULL_CONTROL, { allow: false }))),
      "own",
    );
    assert.strictEqual(
      judgeWriteAcl(withRules(rule(CREATOR_OWNER, FULL_CONTROL, { inheritOnly: true }))),
      "own",
    );
  });
});

describe("repairCommand", () => {
  it("turns inheritance off, lets the three accounts in, and removes every other", () => {
    assert.strictEqual(
      repairCommand(
        String.raw`C:\Users\sam\AppData\Roaming\J3 Bots\server\home`,
        withRules(
          rule(USERS, READ_AND_EXECUTE),
          rule(EVERYONE, WRITE_DATA),
          rule(USERS, WRITE_DATA),
        ),
      ),
      String.raw`icacls 'C:\Users\sam\AppData\Roaming\J3 Bots\server\home' /inheritance:r` +
        ` /remove:d '*${USER}' '*${SYSTEM}' '*${ADMINISTRATORS}'` +
        ` /grant:r '*${USER}:(OI)(CI)F' /grant:r '*${SYSTEM}:(OI)(CI)F' /grant:r '*${ADMINISTRATORS}:(OI)(CI)F'` +
        ` /remove '*${USERS}' '*${EVERYONE}'`,
    );
  });

  it("removes no one when only the three accounts have rules", () => {
    assert.notInclude(repairCommand(String.raw`C:\home`, privateAcl), "/remove ");
  });

  it("names the folder so that PowerShell expands nothing in it", () => {
    const folder = String.raw`C:\Users\o'neil\it’s %TEMP%\$env:TEMP\a & b ^ c`;
    assert.isTrue(
      repairCommand(folder, privateAcl).startsWith(
        String.raw`icacls 'C:\Users\o''neil\it’’s %TEMP%\$env:TEMP\a & b ^ c' /inheritance:r `,
      ),
    );
  });
});

describe.runIf(process.platform === "win32")("on Windows", () => {
  it.live("creates a folder private from the start, and reads it back as private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(yield* fs.makeTempDirectoryScoped(), "home");

      yield* createPrivateFolder(folder);
      const acl = yield* readFolderAcl(folder);

      assert.isTrue(acl.protected);
      // An administrator's elevated process makes folders the Administrators own.
      assert.include([acl.user, ADMINISTRATORS], acl.owner);
      assert.strictEqual(judgeAcl(acl), "private");
      // What is made inside inherits the same three accounts, and no one else.
      const inside = path.join(folder, "bots");
      yield* fs.makeDirectory(inside);
      assert.strictEqual(judgeAcl(yield* readFolderAcl(inside)), "private");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finds a folder opened to the machine's users, and its repair command closes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // What a Command Prompt or PowerShell would expand in double quotes.
      const folder = path.join(yield* fs.makeTempDirectoryScoped(), "o'neil %TEMP% $HOME & ^ home");
      yield* createPrivateFolder(folder);
      yield* openToOthers(folder);

      const opened = yield* readFolderAcl(folder);
      assert.strictEqual(judgeAcl(opened), "open-to-others");

      yield* runInPowerShell(repairCommand(folder, opened));
      assert.strictEqual(judgeAcl(yield* readFolderAcl(folder)), "private");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finds a folder that denies this user writing, and its repair command lets it in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(yield* fs.makeTempDirectoryScoped(), "home");
      yield* createPrivateFolder(folder);
      const { user } = yield* readFolderAcl(folder);
      yield* runInPowerShell(
        `icacls ${powerShellLiteral(folder)} /deny ${powerShellLiteral(`*${user}:(OI)(CI)W`)}`,
      );

      const closed = yield* readFolderAcl(folder);
      assert.strictEqual(judgeAcl(closed), "closed-to-owner");

      yield* runInPowerShell(repairCommand(folder, closed));
      assert.strictEqual(judgeAcl(yield* readFolderAcl(folder)), "private");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reads several folders in one run, each for itself, and counts a rule that denies a group of this user's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const kept = path.join(root, "kept");
        const opened = path.join(root, "opened");
        const denied = path.join(root, "denied");
        const missing = path.join(root, "missing");
        for (const folder of [kept, opened, denied]) yield* createPrivateFolder(folder);
        yield* openToOthers(opened);
        // Everyone, which every token holds.
        yield* runInPowerShell(
          `icacls ${powerShellLiteral(denied)} /deny ${powerShellLiteral("*S-1-1-0:(OI)(CI)W")}`,
        );

        const reads = yield* readFolderAcls([kept, opened, denied, missing]);
        assert.deepStrictEqual(
          reads.map((read) =>
            Result.isSuccess(read) ? judgeAcl(read.success) : read.failure._tag,
          ),
          ["private", "open-to-others", "closed-to-owner", "AclUnreadable"],
        );
        const last = reads.at(-1);
        assert.strictEqual(
          last !== undefined && Result.isFailure(last) ? last.failure.folder : null,
          missing,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says it cannot read a folder that is not there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const missing = path.join(yield* fs.makeTempDirectoryScoped(), "missing");
      const error = yield* Effect.flip(readFolderAcl(missing));
      assert.strictEqual(error._tag, "AclUnreadable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
