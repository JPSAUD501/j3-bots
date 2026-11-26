// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HarnessOutcome,
  HarnessVersion,
  type SignInHarness,
  SignInHarness as SignInHarnessSchema,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { homeLayout } from "../home/entries.ts";

// J3 Bots' own copy of a harness, in its folder of the server's home:
//
//   <home>/harnesses/<provider>/
//     current.json          the version the provider runs, and its executable in that version's folder
//     state.json            the newest version listed at the last check, and how the last install ended
//     versions/<version>/   an installed copy, checked; only the current one stays
//     <version>.partial     a download cut off, resumed by the next install of that version
//     <version>.staging/    where a download is unpacked and run once before it is installed
//
// `current.json` is replaced whole (`Layout.writeFile`), so the switch from
// one version to the next is one rename: a stop at any point leaves either
// the old version current or the new one, each installed whole.

/**
 * A path inside a version's folder, as `current.json` names its executable:
 * relative, with no `..` and no empty part, so it never leads out of it.
 */
export const InnerPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) =>
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
      ? undefined
      : "a relative path inside the folder",
  ),
);

const CurrentCopy = Schema.Struct({
  version: HarnessVersion,
  executable: InnerPath,
});
type CurrentCopy = typeof CurrentCopy.Type;
const CurrentCopyJson = Schema.fromJsonString(CurrentCopy);

export const CopyState = Schema.Struct({
  latest: Schema.NullOr(HarnessVersion),
  last: Schema.NullOr(HarnessOutcome),
});
export type CopyState = typeof CopyState.Type;
export const CopyStateJson = Schema.fromJsonString(Schema.toCodecJson(CopyState));

export const EMPTY_STATE: CopyState = { latest: null, last: null };

/** Where each part of `harness`'s copy is, for the server's home `home`. */
export const copyLayout = (path: Path.Path, home: string, harness: SignInHarness) => {
  const root = homeLayout(path, home).harnessCopy(harness);
  const versions = path.join(root, "versions");
  return {
    root,
    current: path.join(root, "current.json"),
    state: path.join(root, "state.json"),
    versions,
    version: (version: string) => path.join(versions, version),
    partial: (version: string) => path.join(root, `${version}.partial`),
    staging: (version: string) => path.join(root, `${version}.staging`),
  };
};
export type CopyLayout = ReturnType<typeof copyLayout>;

/** An installed copy: its version, and its executable as an absolute path. */
export interface InstalledCopy {
  readonly version: HarnessVersion;
  readonly executable: string;
  /** The executable as `current.json` names it, inside the version's folder. */
  readonly inner: string;
}

/** `current.json`'s text for `copy`. */
export const currentText = (copy: Pick<InstalledCopy, "version" | "inner">) =>
  Schema.encodeEffect(CurrentCopyJson)({ version: copy.version, executable: copy.inner });

/**
 * The copy of `harness` the provider runs, when J3 Bots installed one and its
 * executable is there. A `current.json` that does not read, or names a file
 * that is gone, is no copy: the server then looks on `PATH`, as before any.
 */
export const readCurrent = Effect.fn("harnesses.readCurrent")(function* (
  home: string,
  harness: SignInHarness,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = copyLayout(path, home, harness);
  const current = yield* fs
    .readFileString(layout.current)
    .pipe(Effect.flatMap(Schema.decodeEffect(CurrentCopyJson)), Effect.option);
  if (Option.isNone(current)) return Option.none<InstalledCopy>();
  const { version, executable: inner } = current.value;
  const executable = path.join(layout.version(version), ...inner.split("/"));
  const info = yield* fs.stat(executable).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File"
    ? Option.some<InstalledCopy>({ version, executable, inner })
    : Option.none<InstalledCopy>();
});

/** The executable of each copy J3 Bots installed under `home`, by harness. */
export const ownExecutables = Effect.fn("harnesses.ownExecutables")(function* (home: string) {
  const executables: Partial<Record<SignInHarness, string>> = {};
  for (const harness of SignInHarnessSchema.literals) {
    const copy = yield* readCurrent(home, harness);
    if (Option.isSome(copy)) executables[harness] = copy.value.executable;
  }
  return executables;
});
