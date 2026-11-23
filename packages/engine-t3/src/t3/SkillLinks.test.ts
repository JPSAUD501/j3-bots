// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a FIFO takes mkfifo.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { makePrivateFiles, type PrivateFiles } from "./PrivateFiles.ts";
import { linkSharedSkills } from "./SkillLinks.ts";

/** Every line logged while these tests run, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto, recordLogs);

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nThe steps.\n`;

/**
 * A data directory with a shared skills folder and one harness home, checked
 * as the server checks private state: a location, links resolved through its
 * nearest parent that exists, must be inside the data directory.
 */
const setUp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const outside = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const shared = path.join(root, "shared", "skills");
  const home = path.join(root, "providers", "claude-code");
  yield* fs.makeDirectory(shared, { recursive: true });

  const resolve = (location: string): Effect.Effect<string> =>
    fs.realPath(location).pipe(
      Effect.catch(() => {
        const parent = path.dirname(location);
        return parent === location
          ? Effect.succeed(location)
          : Effect.map(resolve(parent), (real) => path.join(real, path.basename(location)));
      }),
    );
  const files = yield* makePrivateFiles((location) =>
    Effect.map(resolve(location), (real) => real === root || real.startsWith(`${root}${path.sep}`)),
  );

  const addShared = Effect.fnUntraced(function* (name: string, description: string) {
    yield* fs.makeDirectory(path.join(shared, name), { recursive: true });
    yield* fs.writeFileString(path.join(shared, name, "SKILL.md"), skill(name, description));
  });
  /** What the harness reads as the skill `name`: `SKILL.md` in the home's skill folder, links followed. */
  const listed = (name: string) =>
    fs
      .readFileString(path.join(home, "skills", name, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => undefined));
  const record = path.join(root, "engine", "j3", "skill-links", "claude-code.json");
  const link = (through: PrivateFiles = files) =>
    linkSharedSkills({ files: through, home, shared, record });
  /** Where each link in the home's skill folder leads, as the system resolves it. */
  const destinations = Effect.gen(function* () {
    const folder = path.join(home, "skills");
    const real = yield* fs.realPath(folder);
    const found: Array<string> = [];
    for (const name of yield* fs.readDirectory(folder)) {
      found.push(path.resolve(real, yield* fs.readLink(path.join(folder, name))));
    }
    return found;
  });
  return {
    fs,
    path,
    root,
    outside,
    shared,
    home,
    files,
    record,
    addShared,
    listed,
    link,
    destinations,
  };
});

describe("linkSharedSkills", () => {
  it.effect("lets a fresh home list every shared skill, by a link that stays inside the data", () =>
    Effect.gen(function* () {
      const { fs, path, shared, home, addShared, listed, link } = yield* setUp;
      yield* addShared("j3-routines", "Routines");
      yield* addShared("expenses", "Expenses");
      // Not skills: a file, and a folder a harness would never list.
      yield* fs.writeFileString(path.join(shared, "notes.txt"), "a note");
      yield* fs.makeDirectory(path.join(shared, ".trash", "old"), { recursive: true });

      yield* link();

      assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
      assert.strictEqual(yield* listed("expenses"), skill("expenses", "Expenses"));
      assert.deepStrictEqual((yield* fs.readDirectory(path.join(home, "skills"))).toSorted(), [
        "expenses",
        "j3-routines",
      ]);
      // Relative, so it still holds once the data moves; but a junction, as
      // Windows links a folder, holds an absolute path.
      assert.strictEqual(
        path.isAbsolute(yield* fs.readLink(path.join(home, "skills", "expenses"))),
        process.platform === "win32",
      );
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("follows the shared folder at each start, and keeps what else the home holds", () =>
    Effect.gen(function* () {
      const { fs, path, shared, home, addShared, listed, link } = yield* setUp;
      yield* addShared("j3-routines", "Routines");
      yield* addShared("expenses", "Expenses");
      // Codex installs its own skills in its home.
      const system = path.join(home, "skills", ".system", "skill-creator");
      yield* fs.makeDirectory(system, { recursive: true });
      yield* fs.writeFileString(path.join(system, "SKILL.md"), skill("skill-creator", "Codex's"));
      yield* link();

      yield* fs.remove(path.join(shared, "expenses"), { recursive: true });
      yield* addShared("travel", "Travel");
      yield* link();
      yield* link();

      assert.isUndefined(yield* listed("expenses"));
      assert.isFalse(yield* fs.exists(path.join(home, "skills", "expenses")));
      assert.strictEqual(yield* listed("travel"), skill("travel", "Travel"));
      assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
      assert.strictEqual(
        yield* fs.readFileString(path.join(system, "SKILL.md")),
        skill("skill-creator", "Codex's"),
      );
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("lists the home's own skill instead of a shared one of the same name", () =>
    Effect.gen(function* () {
      const { fs, path, home, addShared, listed, link } = yield* setUp;
      yield* addShared("expenses", "The shared one");
      const own = path.join(home, "skills", "expenses");
      yield* fs.makeDirectory(own, { recursive: true });
      yield* fs.writeFileString(path.join(own, "SKILL.md"), skill("expenses", "The home's own"));

      yield* link();
      yield* link();

      assert.strictEqual(yield* listed("expenses"), skill("expenses", "The home's own"));
      assert.strictEqual((yield* fs.lstat(own)).type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("keeps every link in the home it did not make, dot entries included", () =>
    Effect.gen(function* () {
      const { fs, path, home, addShared, listed, link } = yield* setUp;
      yield* addShared("expenses", "Expenses");
      const folder = path.join(home, "skills");
      yield* fs.makeDirectory(folder, { recursive: true });
      // The operator's: one into the shared folder itself, one as J3 Bots would write it.
      const sharedFolder = path.join("..", "..", "..", "shared", "skills");
      yield* fs.symlink(sharedFolder, path.join(folder, ".system"));
      yield* fs.symlink(path.join(sharedFolder, "old"), path.join(folder, "old"));

      yield* link();
      yield* link();

      assert.strictEqual(yield* fs.readLink(path.join(folder, ".system")), sharedFolder);
      assert.strictEqual(
        yield* fs.readLink(path.join(folder, "old")),
        path.join(sharedFolder, "old"),
      );
      assert.strictEqual(yield* listed("expenses"), skill("expenses", "Expenses"));
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("skips a shared entry it cannot read, and links the rest", () =>
    Effect.gen(function* () {
      const { fs, path, shared, home, addShared, listed, link } = yield* setUp;
      yield* addShared("expenses", "Expenses");
      yield* fs.symlink("loop", path.join(shared, "loop"));
      // A folder without a `SKILL.md` that is a regular file.
      yield* fs.makeDirectory(path.join(shared, "folder-skill", "SKILL.md"), { recursive: true });

      yield* link();

      assert.strictEqual(yield* listed("expenses"), skill("expenses", "Expenses"));
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(home, "skills")), ["expenses"]);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("links nothing when the shared skills are a file, and still provisions", () =>
    Effect.gen(function* () {
      const { fs, path, shared, home, link } = yield* setUp;
      yield* fs.remove(shared, { recursive: true });
      yield* fs.writeFileString(shared, "not a folder");

      yield* link();

      assert.deepStrictEqual(yield* fs.readDirectory(path.join(home, "skills")), []);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  describe("never links or writes out of the data directory", () => {
    it.effect("does not link a shared skill whose folder is a link out of it", () =>
      Effect.gen(function* () {
        const { fs, path, outside, shared, addShared, listed, link } = yield* setUp;
        yield* addShared("j3-routines", "Routines");
        yield* fs.writeFileString(path.join(outside, "SKILL.md"), skill("keys", "Elsewhere"));
        yield* fs.symlink(outside, path.join(shared, "keys"));

        yield* link();

        assert.isUndefined(yield* listed("keys"));
        assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
      }).pipe(Effect.scoped, Effect.provide(machine)),
    );

    it.effect("links from where a linked home really is, not where its path says", () =>
      Effect.gen(function* () {
        const { fs, path, root, home, addShared, listed, link, destinations } = yield* setUp;
        yield* addShared("j3-routines", "Routines");
        // The home is a link to a folder one level shallower, still in the data.
        yield* fs.makeDirectory(path.join(root, "shallow"));
        yield* fs.makeDirectory(path.dirname(home), { recursive: true });
        yield* fs.symlink(path.join(root, "shallow"), home);

        yield* link();

        assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
        for (const destination of yield* destinations) {
          assert.isTrue(destination.startsWith(`${root}${path.sep}`), destination);
        }
      }).pipe(Effect.scoped, Effect.provide(machine)),
    );

    it.effect("does not link a shared skill whose SKILL.md is a link", () =>
      Effect.gen(function* () {
        const { fs, path, outside, shared, addShared, listed, link } = yield* setUp;
        yield* fs.writeFileString(path.join(outside, "SKILL.md"), skill("keys", "Elsewhere"));
        yield* fs.makeDirectory(path.join(shared, "keys"));
        yield* fs.symlink(path.join(outside, "SKILL.md"), path.join(shared, "keys", "SKILL.md"));
        yield* addShared("j3-routines", "Routines");

        yield* link();

        assert.isUndefined(yield* listed("keys"));
        assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
      }).pipe(Effect.scoped, Effect.provide(machine)),
    );

    it.effect("unlinks a shared skill whose folder became a link out of it", () =>
      Effect.gen(function* () {
        const { fs, path, outside, shared, home, addShared, listed, link } = yield* setUp;
        yield* addShared("keys", "Shared");
        yield* link();
        yield* fs.writeFileString(path.join(outside, "SKILL.md"), skill("keys", "Elsewhere"));
        yield* fs.remove(path.join(shared, "keys"), { recursive: true });
        yield* fs.symlink(outside, path.join(shared, "keys"));

        yield* link();

        assert.isUndefined(yield* listed("keys"));
        assert.isFalse(yield* fs.exists(path.join(home, "skills", "keys")));
      }).pipe(Effect.scoped, Effect.provide(machine)),
    );

    it.effect("makes and removes nothing through a home skill folder that links out of it", () =>
      Effect.gen(function* () {
        const { fs, path, outside, home, addShared, link } = yield* setUp;
        yield* addShared("j3-routines", "Routines");
        // The operator's own skills, which a link at the home's skill folder would expose.
        yield* fs.makeDirectory(path.join(outside, "personal"));
        yield* fs.makeDirectory(home, { recursive: true });
        yield* fs.symlink(outside, path.join(home, "skills"));

        yield* link();

        assert.deepStrictEqual(yield* fs.readDirectory(outside), ["personal"]);
        assert.strictEqual(yield* fs.readLink(path.join(home, "skills")), outside);
      }).pipe(Effect.scoped, Effect.provide(machine)),
    );

    it.effect(
      "leaves a link someone else put at a shared skill's name, and writes nothing through it",
      () =>
        Effect.gen(function* () {
          const { fs, path, outside, home, addShared, link } = yield* setUp;
          yield* addShared("j3-routines", "Routines");
          yield* fs.makeDirectory(path.join(home, "skills"), { recursive: true });
          yield* fs.symlink(outside, path.join(home, "skills", "j3-routines"));

          yield* link();

          assert.deepStrictEqual(yield* fs.readDirectory(outside), []);
          assert.strictEqual(yield* fs.readLink(path.join(home, "skills", "j3-routines")), outside);
        }).pipe(Effect.scoped, Effect.provide(machine)),
    );
  });
  // Windows has no FIFO.
  it.effect.skipIf(process.platform === "win32")(
    "leaves the home as it is while its record is a FIFO, without opening it",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, record, addShared, listed, link } = yield* setUp;
        yield* addShared("j3-routines", "Routines");
        yield* link();
        yield* fs.makeDirectory(path.dirname(record), { recursive: true });
        yield* fs.remove(record);
        NodeChildProcess.execFileSync("mkfifo", [record]);
        yield* addShared("expenses", "Expenses");
        logged.length = 0;

        yield* link();

        assert.strictEqual((yield* fs.lstat(record)).type, "FIFO");
        assert.strictEqual(yield* listed("j3-routines"), skill("j3-routines", "Routines"));
        assert.isFalse(yield* fs.exists(path.join(home, "skills", "expenses")));
        assert.isTrue(logged.some((line) => line.includes("is not a regular file")));
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("records no link it was refused, so a link put there later stays", () =>
    Effect.gen(function* () {
      const { fs, path, outside, shared, home, files, link } = yield* setUp;
      // Taken for private when it is checked, refused when the link is made.
      yield* fs.symlink(outside, path.join(shared, "keys"));
      yield* fs.writeFileString(path.join(outside, "SKILL.md"), skill("keys", "Elsewhere"));
      yield* link({ ...files, contains: () => Effect.succeed(true) });
      assert.isFalse(yield* fs.exists(path.join(home, "skills", "keys")));

      // No longer shared, and the operator links the name by the path J3 Bots would have used.
      yield* fs.remove(path.join(shared, "keys"));
      const folder = path.join(home, "skills");
      const target = path.relative(folder, path.join(shared, "keys"));
      yield* fs.symlink(target, path.join(folder, "keys"));

      yield* link();

      assert.strictEqual(yield* fs.readLink(path.join(folder, "keys")), target);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
