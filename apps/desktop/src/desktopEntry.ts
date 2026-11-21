// SPDX-License-Identifier: AGPL-3.0-or-later

// The Linux desktop entry that makes the app the handler of its links. The
// escaping follows the Desktop Entry Specification as T3 Code applies it
// (MIT, read at c6ca01b3, `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`).

/** A value of a string key: backslash and the control characters it names, escaped. */
const escapeString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

/**
 * One argument of `Exec`, quoted. `Exec` is unescaped as a string first, then
 * unquoted, so the quoting is applied first and the string escaping over it;
 * `%` stands for a field code unless doubled.
 */
const quoteArgument = (value: string): string =>
  escapeString(
    `"${value
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("$", "\\$")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")}"`,
  );

/**
 * A word of `Exec`, quoted only when it must be: `xdg-open` without a desktop
 * environment it knows reads the words as they are written, unquoted (seen
 * with xdg-utils on Ubuntu 26.04), and an old one looks the program up that way.
 */
const execWord = (value: string): string =>
  /[ \t\n"'\\><~|&;$*?#()`]/.test(value)
    ? quoteArgument(value)
    : escapeString(value.replaceAll("%", "%%"));

interface LinkHandlerEntry {
  /** The name a chooser shows. */
  readonly name: string;
  /** The program a link starts, then the arguments it is given before the link. */
  readonly command: ReadonlyArray<string>;
  /** The scheme it handles, without its colon. */
  readonly scheme: string;
}

/**
 * A hidden entry that only handles the app's links: it is not listed among the
 * system's applications, so it never stands beside the app's own launcher.
 * The links it is given arrive as the last argument (`%U`).
 */
export const renderLinkHandlerEntry = ({ name, command, scheme }: LinkHandlerEntry): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeString(name)}`,
    `Exec=${command.map(execWord).join(" ")} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${scheme};`,
    "",
  ].join("\n");
