// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { withFolders } from "./harnesses.ts";

describe("withFolders", () => {
  it("adds the folders an installer put on Windows' PATH since, once each, after the server's own", () => {
    assert.strictEqual(
      withFolders(
        "C:\\Windows\\system32;C:\\Users\\Ana\\AppData\\Roaming\\npm",
        'c:\\users\\ana\\appdata\\roaming\\NPM;"C:\\Program Files\\Codex";;C:\\Program Files\\Codex',
        "win32",
      ),
      'C:\\Windows\\system32;C:\\Users\\Ana\\AppData\\Roaming\\npm;"C:\\Program Files\\Codex"',
    );
  });

  it("keeps a folder whose case differs where case tells folders apart", () => {
    assert.strictEqual(withFolders("/usr/bin", "/USR/bin:/usr/bin", "linux"), "/usr/bin:/USR/bin");
  });
});
