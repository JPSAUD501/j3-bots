// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  powerShellLiteral,
  windowsCommandWord,
  windowsCommandWords,
  windowsNameKey,
} from "./windows.ts";

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

describe("windowsNameKey", () => {
  it("gives names that differ only in the case of an ASCII or Latin-1 letter one key", () => {
    assert.strictEqual(
      windowsNameKey(String.raw`C:\Users\Ada\Área`),
      windowsNameKey(String.raw`c:\users\ADA\área`),
    );
  });

  it("never gives one key to names a volume can keep apart", () => {
    const apart: ReadonlyArray<readonly [string, string]> = [
      // The Kelvin sign is not a K, and a sharp s has no one-unit capital.
      ["\u212a", "k"],
      ["straße", "STRASSE"],
      // A dotted capital I is not an i followed by a combining dot.
      ["\u0130", "i\u0307"],
      // Windows' default table keeps these apart from what Unicode makes their capitals.
      ["D:\\\u0131", "D:\\I"],
      ["\u017f", "S"],
      ["D:\\\u00b5Tools\\bin", "D:\\\u03bcTools\\bin"],
    ];
    for (const [one, other] of apart) {
      assert.notStrictEqual(windowsNameKey(one), windowsNameKey(other), `${one} and ${other}`);
    }
  });
});

describe("powerShellLiteral", () => {
  it("doubles every quote PowerShell ends a literal with, typographic ones too", () => {
    assert.strictEqual(powerShellLiteral("it's"), "'it''s'");
    assert.strictEqual(powerShellLiteral("a‘b’c‚d‛e"), "'a‘‘b’’c‚‚d‛‛e'");
  });
});
