// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a shipped skill's copies are recognized by their SHA-256, from node:crypto.
import * as NodeCrypto from "node:crypto";
import { sharedSkills } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Layout } from "../Layout.ts";

/** The file a harness reads in each skill's folder. */
const SKILL_FILE = "SKILL.md";

/**
 * Beside a shipped skill's `SKILL.md`: the SHA-256 of each text J3 Bots wrote
 * there and has not yet seen replaced, so a later start can tell its own copy
 * from a skill the operator put under the same name.
 */
const RECORD_FILE = ".j3-shipped.json";

const ShippedRecord = Schema.fromJsonString(Schema.Struct({ sha256: Schema.Array(Schema.String) }));
const decodeRecord = Schema.decodeUnknownOption(ShippedRecord);
const encodeRecord = Schema.encodeEffect(ShippedRecord);

/** What is at a shipped skill's `SKILL.md`. */
type Current =
  | { readonly _tag: "absent" }
  | { readonly _tag: "text"; readonly text: string }
  /** Not a file the server can read: a folder, say. */
  | { readonly _tag: "unreadable" };
const ABSENT: Current = { _tag: "absent" };
const UNREADABLE: Current = { _tag: "unreadable" };

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * Writes the skills J3 Bots ships into the home's shared skills, as
 * `<name>/SKILL.md` (`docs/prompts/architecture.md#skills`), where the engine
 * links every shared skill into each harness home. A release's text replaces
 * the copy an earlier one installed; a skill under any other name is left
 * alone.
 *
 * A `SKILL.md` already at a shipped name that is not a copy J3 Bots installed
 * (its digest is not in the folder's record) is the operator's: it is kept,
 * with a warning, and the shipped text is not installed. So is one that
 * cannot be read as a file.
 *
 * A shipped skill's folder must be a real folder directly in the shared
 * skills, links resolved. One that is a link to another skill's folder, or to
 * anywhere else, or is not a folder at all, is skipped with a warning, so the
 * install never writes over a skill under another name. So is every skill
 * when the shared skills folder itself has left private state.
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
      PlatformError: Effect.die,
    }),
  );
  if (realRoot === undefined) return;

  const write = (file: string, text: string) =>
    layout.writeFile(file, text).pipe(
      Effect.as(true),
      Effect.catchTags({
        PrivateLocationExposed: (error) =>
          Effect.as(Effect.logWarning(`${error.message} It was skipped.`), false),
        PlatformError: Effect.die,
      }),
    );
  const writeRecord = Effect.fnUntraced(function* (file: string, digests: ReadonlyArray<string>) {
    return yield* write(file, yield* encodeRecord({ sha256: digests }).pipe(Effect.orDie));
  });

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
    const recordFile = path.join(folder, RECORD_FILE);
    const current = yield* fs.readFileString(skillFile).pipe(
      Effect.map((text): Current => ({ _tag: "text", text })),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(ABSENT)),
      // A folder at its name, or a file the server cannot read: not one it wrote.
      Effect.catchTag("PlatformError", () => Effect.succeed(UNREADABLE)),
    );
    const recorded = yield* fs.readFileString(recordFile).pipe(
      Effect.map((text) =>
        Option.match(decodeRecord(text), {
          onNone: (): ReadonlyArray<string> => [],
          onSome: (record) => record.sha256,
        }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    const shipped = digest(skill.text);

    const installed =
      current._tag === "absent" ||
      (current._tag === "text" &&
        (current.text === skill.text || recorded.includes(digest(current.text))));
    if (!installed) {
      yield* Effect.logWarning(
        `${skillFile} is not a copy J3 Bots installed, so it was kept and the ${skill.name} skill J3 Bots ships was not installed. Move it aside to get the shipped one.`,
      );
      continue;
    }

    if (current._tag !== "text" || current.text !== skill.text) {
      // Both, until the new text is in place, so a start cut short between
      // the two writes still recognizes the copy it leaves.
      const before = current._tag === "text" ? [digest(current.text)] : [];
      if (!(yield* writeRecord(recordFile, [...before, shipped]))) continue;
      if (!(yield* write(skillFile, skill.text))) continue;
    }
    if (recorded.length !== 1 || recorded[0] !== shipped) {
      yield* writeRecord(recordFile, [shipped]);
    }
  }
});
