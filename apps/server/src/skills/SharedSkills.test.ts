// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- an earlier release's install is recorded by its SHA-256, and a FIFO takes mkfifo.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { sharedSkills } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Layout from "../Layout.ts";
import * as TestDatabase from "../testing/database.ts";
import * as SharedSkills from "./SharedSkills.ts";

const home = Layout.layer.pipe(Layer.provideMerge(TestDatabase.layer));

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The first shipped skill, where its `SKILL.md` goes, and the server's record of what it wrote. */
const shippedSkill = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { sharedSkills: folder, shippedSkills: record } = yield* Layout.Layout;
  const [shipped] = sharedSkills;
  assert.isDefined(shipped);
  // So a test can put a record there before the server writes one.
  yield* (yield* FileSystem.FileSystem).makeDirectory(path.dirname(record), { recursive: true });
  return { folder, shipped, record, file: path.join(folder, shipped.name, "SKILL.md") };
});

it.effect("installs each shipped skill, then replaces its copy with a later release's text", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { folder, shipped, record, file } = yield* shippedSkill;
    const ownFile = path.join(folder, "expenses", "SKILL.md");
    yield* fs.makeDirectory(path.dirname(ownFile), { recursive: true });
    yield* fs.writeFileString(ownFile, "the operator's text");

    yield* SharedSkills.install();
    for (const skill of sharedSkills) {
      assert.strictEqual(
        yield* fs.readFileString(path.join(folder, skill.name, "SKILL.md")),
        skill.text,
      );
    }

    // The copy an earlier release installed, as the server recorded it.
    const older = "an older text";
    yield* fs.writeFileString(file, older);
    yield* fs.writeFileString(record, JSON.stringify({ [shipped.name]: [digest(older)] }));
    yield* SharedSkills.install();
    assert.strictEqual(yield* fs.readFileString(file), shipped.text);
    assert.strictEqual(yield* fs.readFileString(ownFile), "the operator's text");
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(record)), {
      [shipped.name]: [digest(shipped.text)],
    });
  }).pipe(Effect.provide(home)),
);

it.effect("keeps a skill the operator put under a shipped skill's name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { file } = yield* shippedSkill;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "the operator's own routines skill");

    yield* SharedSkills.install();
    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(file), "the operator's own routines skill");
  }).pipe(Effect.provide(home)),
);

it.effect("does not write through a shipped skill's folder that links to another skill", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { folder, shipped } = yield* shippedSkill;
    const ownFile = path.join(folder, "expenses", "SKILL.md");
    yield* fs.makeDirectory(path.dirname(ownFile), { recursive: true });
    yield* fs.writeFileString(ownFile, "the operator's text");
    yield* fs.symlink(path.join(folder, "expenses"), path.join(folder, shipped.name));

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(ownFile), "the operator's text");
  }).pipe(Effect.provide(home)),
);

it.effect("finishes an upgrade cut short between recording the new text and writing it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { shipped, record, file } = yield* shippedSkill;
    const older = "an older text";
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, older);
    yield* fs.writeFileString(
      record,
      JSON.stringify({ [shipped.name]: [digest(older), digest(shipped.text)] }),
    );

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(file), shipped.text);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(record)), {
      [shipped.name]: [digest(shipped.text)],
    });
  }).pipe(Effect.provide(home)),
);

it.effect("installs over a corrupt record, and writes a readable one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { shipped, record, file } = yield* shippedSkill;
    yield* fs.writeFileString(record, "{ not json");

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(file), shipped.text);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(record)), {
      [shipped.name]: [digest(shipped.text)],
    });
  }).pipe(Effect.provide(home)),
);

it.effect("grants nothing to a record put in the skill's own folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { file } = yield* shippedSkill;
    const imported = "an imported skill under the shipped name";
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, imported);
    yield* fs.writeFileString(
      path.join(path.dirname(file), ".j3-shipped.json"),
      JSON.stringify({ sha256: [digest(imported)] }),
    );

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(file), imported);
  }).pipe(Effect.provide(home)),
);

it.effect("keeps a SKILL.md that is a link, and never writes through it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { folder, file } = yield* shippedSkill;
    const ownFile = path.join(folder, "expenses", "SKILL.md");
    yield* fs.makeDirectory(path.dirname(ownFile), { recursive: true });
    yield* fs.writeFileString(ownFile, "the operator's text");
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.symlink(ownFile, file);

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readLink(file), ownFile);
    assert.strictEqual(yield* fs.readFileString(ownFile), "the operator's text");
  }).pipe(Effect.provide(home)),
);

it.effect("keeps a SKILL.md that is a FIFO, without opening it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { file } = yield* shippedSkill;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    NodeChildProcess.execFileSync("mkfifo", [file]);

    yield* SharedSkills.install();

    assert.strictEqual((yield* fs.lstat(file)).type, "FIFO");
  }).pipe(Effect.provide(home)),
);

it.effect("installs nothing while the record is a folder, and still starts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { record, file } = yield* shippedSkill;
    yield* fs.makeDirectory(record);

    yield* SharedSkills.install();

    assert.isFalse(yield* fs.exists(file));
    assert.strictEqual((yield* fs.stat(record)).type, "Directory");
  }).pipe(Effect.provide(home)),
);

it.effect("installs nothing while the shared skills are a file, and still starts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { folder } = yield* shippedSkill;
    yield* fs.makeDirectory(path.dirname(folder), { recursive: true });
    yield* fs.writeFileString(folder, "not a folder");

    yield* SharedSkills.install();

    assert.strictEqual(yield* fs.readFileString(folder), "not a folder");
  }).pipe(Effect.provide(home)),
);
