// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a shipped skill's copies are recognized by their SHA-256, from node:crypto.
import * as NodeCrypto from "node:crypto";
import { type SharedSkill, sharedSkills } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Layout } from "../Layout.ts";

/** The file a harness reads in each skill's folder. */
const SKILL_FILE = "SKILL.md";

/**
 * The record at `Layout.shippedSkills`: by shipped skill, the SHA-256 of each
 * text the server wrote as its `SKILL.md` and has not yet seen replaced, so a
 * later start can tell its own copy from a skill the operator put under the
 * same name. It is kept outside the shared skills, so nothing put in a skill's
 * folder can claim a copy as the server's.
 */
const ShippedRecord = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
);
const decodeRecord = Schema.decodeUnknownOption(ShippedRecord);
const encodeRecord = Schema.encodeEffect(ShippedRecord);

/**
 * Texts a release installed before the server kept its record, by skill, as
 * their SHA-256: `j3-routines` as #27 shipped it. A copy that still holds one
 * is the server's, and a later text replaces it.
 */
const SHIPPED_BEFORE_THE_RECORD: Partial<Record<SharedSkill["name"], ReadonlyArray<string>>> = {
  "j3-routines": ["ee729ac25824581ebc0a3b2ef3182444ebc203cb838200f3139a986a387ed241"],
};

/** What is at a file the installer reads, checked with `lstat` before it is opened. */
type Found =
  | { readonly _tag: "absent" }
  | { readonly _tag: "text"; readonly text: string }
  /** A link, a folder, a FIFO, or a file that cannot be read: never opened, or not read. */
  | { readonly _tag: "other" };
const ABSENT: Found = { _tag: "absent" };
const OTHER: Found = { _tag: "other" };

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Reads `file` only when it is a regular file, so a link is never followed and a FIFO never opened. */
const readRegular = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(file).pipe(
    Effect.flatMap((info): Effect.Effect<Found, PlatformError.PlatformError> =>
      info.type === "File"
        ? Effect.map(fs.readFileString(file), (text) => ({ _tag: "text", text }))
        : Effect.succeed(OTHER),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(ABSENT)),
    Effect.catchTag("PlatformError", () => Effect.succeed(OTHER)),
  );
});

/**
 * Writes the skills J3 Bots ships into the home's shared skills, as
 * `<name>/SKILL.md` (`docs/prompts/architecture.md#skills`), where the engine
 * links every shared skill into each harness home. A release's text replaces
 * the copy an earlier one installed; a skill under any other name is left
 * alone.
 *
 * A `SKILL.md` already at a shipped name is the server's when it holds the
 * shipped text or a text the server recorded writing there (or one installed
 * before it kept that record). Anything else is the operator's: it is kept,
 * with a warning, and the shipped text is not installed. So is a `SKILL.md`
 * that is not a regular file (a link, a folder, a FIFO), which is never read.
 *
 * A shipped skill's folder must be a real folder directly in the shared
 * skills, links resolved. One that is a link to another skill's folder, or to
 * anywhere else, or is not a folder at all, is skipped with a warning, so the
 * install never writes over a skill under another name. So is every skill
 * when the shared skills folder has left private state or is not a folder,
 * and when the record is not a regular file. A write that fails stops the
 * install with a warning, and the skills already there are kept: shared
 * skills never stop the server from starting.
 */
export const install = Effect.fn("SharedSkills.install")(function* () {
  const layout = yield* Layout;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const realRoot = yield* layout.writable(layout.sharedSkills).pipe(
    Effect.tap((root) => fs.makeDirectory(root, { recursive: true })),
    Effect.flatMap((root) => fs.realPath(root)),
    Effect.catchTags({
      PrivateLocationExposed: (error) =>
        Effect.as(Effect.logWarning(`${error.message} No skill was installed.`), undefined),
      PlatformError: (error) =>
        Effect.as(
          Effect.logWarning(
            `${layout.sharedSkills} cannot be used as a folder (${error.message}), so no skill was installed.`,
          ),
          undefined,
        ),
    }),
  );
  if (realRoot === undefined) return;

  // The folder first: Windows says a file under a file is missing, not that
  // its folder is not one.
  const state = path.dirname(layout.shippedSkills);
  const stateInTheWay = yield* fs.stat(state).pipe(
    Effect.map((info) => info.type !== "Directory"),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    Effect.orElseSucceed(() => true),
  );
  const saved = stateInTheWay ? undefined : yield* readRegular(layout.shippedSkills);
  if (saved === undefined || saved._tag === "other") {
    const [where, what] =
      saved === undefined ? [state, "a folder"] : [layout.shippedSkills, "a regular file"];
    return yield* Effect.logWarning(
      `${where} is not ${what}, so no shipped skill was installed or replaced. Move it aside.`,
    );
  }
  const record: Record<string, ReadonlyArray<string>> = {};
  if (saved._tag === "text") {
    const decoded = decodeRecord(saved.text);
    if (Option.isSome(decoded)) Object.assign(record, decoded.value);
    else
      yield* Effect.logWarning(
        `${layout.shippedSkills} could not be decoded, so only the shipped texts are recognized as the server's.`,
      );
  }

  // A write that fails for any reason but containment stops the install.
  const write = (file: string, text: string) =>
    layout.writeFile(file, text).pipe(
      Effect.as(true),
      Effect.catchTag("PrivateLocationExposed", (error) =>
        Effect.as(Effect.logWarning(`${error.message} It was skipped.`), false),
      ),
    );
  /** Records `digests` as the texts of `name` the server wrote, unless they are recorded already. */
  const recordAs = Effect.fnUntraced(function* (name: string, digests: ReadonlyArray<string>) {
    const before = record[name];
    if (before?.length === digests.length && before.every((each, i) => each === digests[i])) {
      return true;
    }
    record[name] = digests;
    const text = yield* encodeRecord(record).pipe(Effect.orDie);
    return yield* write(layout.shippedSkills, text);
  });

  const installEach = Effect.fnUntraced(function* () {
    for (const skill of sharedSkills) {
      const folder = path.join(layout.sharedSkills, skill.name);
      const isOwnFolder = yield* fs.makeDirectory(folder, { recursive: true }).pipe(
        Effect.andThen(fs.realPath(folder)),
        Effect.flatMap((real) =>
          real === path.join(realRoot, skill.name)
            ? Effect.map(fs.stat(real), (info) => info.type === "Directory")
            : Effect.succeed(false),
        ),
        // Something that is not a folder, or a link to nowhere, is in the way.
        Effect.catchTag("PlatformError", () => Effect.succeed(false)),
      );
      if (!isOwnFolder) {
        yield* Effect.logWarning(
          `${folder} is not a folder of its own in the shared skills, so the ${skill.name} skill was not installed there.`,
        );
        continue;
      }

      const skillFile = path.join(folder, SKILL_FILE);
      const current = yield* readRegular(skillFile);
      if (current._tag === "other") {
        yield* Effect.logWarning(
          `${skillFile} is not a regular file the server can read, so it was kept and the ${skill.name} skill J3 Bots ships was not installed. Move it aside to get the shipped one.`,
        );
        continue;
      }
      const shipped = digest(skill.text);
      const ours = new Set([
        shipped,
        ...(record[skill.name] ?? []),
        ...(SHIPPED_BEFORE_THE_RECORD[skill.name] ?? []),
      ]);
      if (current._tag === "text" && !ours.has(digest(current.text))) {
        yield* Effect.logWarning(
          `${skillFile} is not a copy J3 Bots installed, so it was kept and the ${skill.name} skill J3 Bots ships was not installed. Move it aside to get the shipped one.`,
        );
        continue;
      }

      if (current._tag === "absent" || current.text !== skill.text) {
        // Both, until the new text is in place, so a start cut short between
        // the two writes still recognizes the copy it leaves.
        const before = current._tag === "text" ? [digest(current.text)] : [];
        if (!(yield* recordAs(skill.name, [...before, shipped]))) continue;
        if (!(yield* write(skillFile, skill.text))) continue;
      }
      yield* recordAs(skill.name, [shipped]);
    }
  });
  yield* installEach().pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.logWarning(
        `The shipped skills could not be installed (${error.message}), so the install stopped and the skills already there were kept.`,
      ),
    ),
  );
});
