// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { powerShellLiteral, windowsCommandWord, windowsCommandWords } from "./windows.ts";

describe("windowsCommandWords", () => {
  it("splits as the C runtime does: quotes group, and backslashes count only before a quote", () => {
    assert.deepStrictEqual(
      windowsCommandWords(
        String.raw`"C:\Program Files\J3 Bots\t3.exe" serve --base-dir "C:\Users\Sam\AppData\Roaming\J3 Bots\server\home\engine" --port 3748`,
      ),
      [
        String.raw`C:\Program Files\J3 Bots\t3.exe`,
        "serve",
        "--base-dir",
        String.raw`C:\Users\Sam\AppData\Roaming\J3 Bots\server\home\engine`,
        "--port",
        "3748",
      ],
    );
    assert.deepStrictEqual(windowsCommandWords(String.raw`a\\\"b "c\\" d\e "f""g"`), [
      String.raw`a\"b`,
      "c\\",
      String.raw`d\e`,
      'f"g',
    ]);
    assert.deepStrictEqual(windowsCommandWords(' \t one  ""  two '), ["one", "", "two"]);
  });
});

describe("windowsCommandWord", () => {
  it("quotes a word so that Windows' splitting gives it back as it was", () => {
    const words = [
      "serve",
      String.raw`C:\Users\Sam Lee\AppData\Roaming\J3 Bots\server\home\engine`,
      "C:\\Folder Ending In\\",
      String.raw`a\"b`,
      'say "hi"',
      "",
      "tab\there",
      "\\\\server\\share\\",
    ];
    assert.deepStrictEqual(windowsCommandWords(words.map(windowsCommandWord).join(" ")), words);
    // A word with nothing to quote is left as it is.
    assert.strictEqual(windowsCommandWord(String.raw`C:\J3\t3.exe`), String.raw`C:\J3\t3.exe`);
  });
});

describe("powerShellLiteral", () => {
  it("doubles every quote PowerShell ends a literal with, typographic ones too", () => {
    assert.strictEqual(powerShellLiteral("it's"), "'it''s'");
    assert.strictEqual(powerShellLiteral("a‘b’c‚d‛e"), "'a‘‘b’’c‚‚d‛‛e'");
  });
});
