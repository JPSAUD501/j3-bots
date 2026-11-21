// SPDX-License-Identifier: AGPL-3.0-or-later
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

it.effect(
  "writes each shipped skill over an older copy and leaves the operator's skills alone",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { sharedSkills: folder } = yield* Layout.Layout;
      const [shipped] = sharedSkills;
      assert.isDefined(shipped);
      const shippedFile = path.join(folder, shipped.name, "SKILL.md");
      const ownFile = path.join(folder, "expenses", "SKILL.md");
      for (const file of [shippedFile, ownFile]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "an older text");
      }

      yield* SharedSkills.install();

      for (const skill of sharedSkills) {
        assert.strictEqual(
          yield* fs.readFileString(path.join(folder, skill.name, "SKILL.md")),
          skill.text,
        );
      }
      assert.strictEqual(yield* fs.readFileString(ownFile), "an older text");
    }).pipe(Effect.provide(home)),
);
