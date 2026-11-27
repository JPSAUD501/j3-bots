// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// An X window says which app it belongs to only by its class (`WM_CLASS`):
// `Google-chrome`, `org.gnome.Nautilus`. The name a person knows the app by
// is in its desktop entry (freedesktop.org's Desktop Entry Specification),
// which names the class it opens windows of (`StartupWMClass`), or is named
// after it. This reads the entries where the XDG Base Directory
// Specification puts them, as a dock does.

/** A window's class, as `WM_CLASS` holds it: its instance's name, then its class's. */
export interface WindowClass {
  readonly instance: string;
  readonly className: string;
}

/** `WM_CLASS`'s value: two strings, each ended by a zero byte. */
export const windowClassOf = (value: Uint8Array): WindowClass | null => {
  const [instance, className] = new TextDecoder("latin1").decode(value).split("\0");
  if (instance === undefined || className === undefined || className === "") return null;
  return { instance, className };
};

/** What the app reads of a desktop entry: its names by locale (`""`, the default), and the class it opens. */
interface Entry {
  readonly names: ReadonlyMap<string, string>;
  readonly startupClass: string | null;
}

/** The `[Desktop Entry]` group of a desktop entry's text; `null` for one that is hidden or has no name. */
const parseEntry = (text: string): Entry | null => {
  const names = new Map<string, string>();
  let startupClass: string | null = null;
  let inEntry = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    const name = /^Name(?:\[([^\]]+)\])?$/.exec(key);
    if (name !== null) names.set(name[1] ?? "", value);
    else if (key === "StartupWMClass") startupClass = value;
    else if (key === "Hidden" && value === "true") return null;
  }
  return names.has("") ? { names, startupClass } : null;
};

/**
 * An entry's name in `locale` (`pt-BR`), as the specification matches it:
 * `Name[pt_BR]`, then `Name[pt]`, then `Name`.
 */
const nameIn = (entry: Entry, locale: string): string | null => {
  const [language = "", country] = locale.split(/[-_]/);
  return (
    (country === undefined ? undefined : entry.names.get(`${language}_${country.toUpperCase()}`)) ??
    entry.names.get(language) ??
    entry.names.get("") ??
    null
  );
};

/** Whether `entry`, kept in a file named `stem`.desktop, is the one for windows of `window`. */
const opens = (entry: Entry, stem: string, window: WindowClass): boolean => {
  const known = [window.className, window.instance].map((name) => name.toLowerCase());
  if (entry.startupClass !== null) return known.includes(entry.startupClass.toLowerCase());
  return known.includes(stem.toLowerCase());
};

/** The folders desktop entries are kept in, the operator's own first. */
export const entryFolders = (
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): ReadonlyArray<string> => {
  const home = env["XDG_DATA_HOME"] || `${homeDirectory}/.local/share`;
  const shared = (env["XDG_DATA_DIRS"] || "/usr/local/share:/usr/share").split(":");
  return [home, ...shared]
    .filter((folder) => folder !== "")
    .map((folder) => `${folder}/applications`);
};

/**
 * The name a person knows the app of `window` by, in `locale`, from the
 * first desktop entry in `folders` that opens its windows; `null` when none
 * does, or none could be read.
 */
export const appNameFor = Effect.fn("desktop.appNameFor")(function* (
  window: WindowClass,
  folders: ReadonlyArray<string>,
  locale: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const folder of folders) {
    const files = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    for (const file of files) {
      if (!file.endsWith(".desktop")) continue;
      const stem = file.slice(0, -".desktop".length);
      const text = yield* fs
        .readFileString(path.join(folder, file))
        .pipe(Effect.orElseSucceed(() => ""));
      const entry = parseEntry(text);
      if (entry !== null && opens(entry, stem, window)) return nameIn(entry, locale);
    }
  }
  return null;
});
