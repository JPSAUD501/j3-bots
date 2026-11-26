// SPDX-License-Identifier: AGPL-3.0-or-later

// What J3 Bots needs to start programs on Windows without a shell: command
// lines split and quoted as the programs it starts read them, names compared
// as Windows' file systems compare them, and Windows PowerShell 5.1, by its
// full path, for what Node cannot ask Windows itself.

/**
 * The words of a Windows command line, split as programs built with the
 * Microsoft C runtime split theirs (`CommandLineToArgvW`): a space or a tab
 * ends a word outside quotes; `"` opens or closes quoting; `2n` backslashes
 * before a quote are `n` backslashes and the quote does its work; `2n+1` are
 * `n` and a literal quote; other backslashes are themselves.
 */
export const windowsCommandWords = (line: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    if (character === "\\") {
      let backslashes = 0;
      while (line[at] === "\\") {
        backslashes++;
        at++;
      }
      if (line[at] === '"') {
        word += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) word += '"';
        else quoted = !quoted;
      } else {
        word += "\\".repeat(backslashes);
        at--;
      }
      inWord = true;
    } else if (character === '"') {
      // Inside quotes, `""` is one literal quote.
      if (quoted && line[at + 1] === '"') {
        word += '"';
        at++;
      } else {
        quoted = !quoted;
      }
      inWord = true;
    } else if ((character === " " || character === "\t") && !quoted) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += character;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
};

/**
 * `word` as a Windows command line gives it to a program that splits its line
 * as `windowsCommandWords` does: as it is when nothing in it needs quoting,
 * otherwise in quotes, with every backslash before a quote, and before the
 * closing one, doubled, and each quote escaped.
 */
export const windowsCommandWord = (word: string): string => {
  if (word !== "" && !/[ \t\n\v"]/.test(word)) return word;
  let quoted = '"';
  let backslashes = 0;
  for (const character of word) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted +=
      character === '"'
        ? `${"\\".repeat(backslashes * 2 + 1)}"`
        : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

/**
 * `name`, a path or a part of one, as a key that is the same for two names
 * Windows' file systems take for one only where every NTFS volume agrees:
 * NTFS compares names by an upcase table, one UTF-16 unit for one, and every
 * table since Windows NT maps the lowercase ASCII and Latin-1 letters to
 * their capitals (`a`–`z`, `à`–`þ` but `÷`). Beyond those, the table is the
 * one of the Windows that formatted the volume, and tables differ from
 * Unicode's and from each other: Windows' default keeps the dotless `ı`, the
 * long `ſ` and the micro sign `µ` apart from `I`, `S` and the Greek `Μ`,
 * which Unicode makes their capitals (**Read** in ntfs-3g's
 * `ntfs_upcase_table_build`, which rebuilds that table). So every other unit
 * is kept as it is: two names that differ only in the case of another letter
 * get different keys, and a caller takes them for two (a path outside a
 * folder, a search path folder kept twice), never two names a volume keeps
 * apart for one. Lower-casing the whole name, as `toLowerCase` does, would
 * take the Kelvin sign `K` for `k`.
 */
export const windowsNameKey = (name: string): string => {
  let key = "";
  for (let at = 0; at < name.length; at++) {
    const unit = name.charCodeAt(at);
    const folds = (unit >= 0x61 && unit <= 0x7a) || (unit >= 0xe0 && unit <= 0xfe && unit !== 0xf7);
    key += folds ? String.fromCharCode(unit - 0x20) : (name[at] ?? "");
  }
  return key;
};

/**
 * `value` as a PowerShell string literal, which reads nothing in it but its
 * quotes. PowerShell takes the typographic single quotes (‘ ’ ‚ ‛) for `'`
 * too, so each of them is doubled as well.
 */
export const powerShellLiteral = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

/**
 * A program in Windows' own `System32`, by its full path: the search path,
 * which the operator's shell set, is never asked for it.
 */
export const system32 = (
  environment: Readonly<Record<string, string | undefined>>,
  program: string,
) => `${environment["SystemRoot"] ?? "C:\\Windows"}\\System32\\${program}`;

/**
 * The arguments that run `script` in Windows PowerShell without a profile or
 * a prompt, stopping at the first error, its output as UTF-8. The script goes
 * as base64 of its UTF-16 text, as `-EncodedCommand` takes it, so nothing in
 * it needs quoting for the command line.
 */
export const powerShellArgs = (script: string): ReadonlyArray<string> => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    "utf16le",
  ).toString("base64"),
];

/**
 * `environment` without `PSModulePath`, which PowerShell 7 sets to its own
 * modules: Windows PowerShell 5.1 started from a PowerShell 7 session, as a
 * terminal or a CI runner opens one, inherits it, and then fails to load the
 * modules its first command is in. Without it, 5.1 finds its own.
 */
export const withoutModulePath = (environment: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== "PSMODULEPATH",
    ),
  );

/** Windows PowerShell 5.1, which every supported Windows ships. */
export const POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";
