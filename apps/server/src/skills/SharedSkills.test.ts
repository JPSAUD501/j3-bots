// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- an earlier release's install is recorded by its SHA-256.
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

/** The first shipped skill, and where its `SKILL.md` goes. */
const shippedSkill = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { sharedSkills: folder } = yield* Layout.Layout;
  const [shipped] = sharedSkills;
  assert.isDefined(shipped);
  return { folder, shipped, file: path.join(folder, shipped.name, "SKILL.md") };
});

it.effect("installs each shipped skill, then replaces its copy with a later release's text", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { folder, shipped, file } = yield* shippedSkill;
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

    // The copy an earlier release installed, as that release recorded it.
    const older = "an older text";
    yield* fs.writeFileString(file, older);
    yield* fs.writeFileString(
      path.join(path.dirname(file), ".j3-shipped.json"),
      JSON.stringify({ sha256: [NodeCrypto.createHash("sha256").update(older).digest("hex")] }),
    );
    yield* SharedSkills.install();
    assert.strictEqual(yield* fs.readFileString(file), shipped.text);
    assert.strictEqual(yield* fs.readFileString(ownFile), "the operator's text");
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
