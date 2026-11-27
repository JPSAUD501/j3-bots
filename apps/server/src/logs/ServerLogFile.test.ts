// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { appendLines, KEPT_FILES, logFiles, MAX_FILE_BYTES, SERVER_LOG } from "./ServerLogFile.ts";

const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ n: Schema.Number })),
);

it.layer(NodeServices.layer)("the server's log in its home", (it) => {
  it.effect("moves a full file aside, keeps lines whole and drops the oldest past the bound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "j3-log-" }), "logs");
      // A line of a quarter of a file: four fill a file, and the fifth begins the next.
      const line = (n: number) => `{"n":${n},"pad":"${"x".repeat(MAX_FILE_BYTES / 4 - 20)}"}`;
      const written = KEPT_FILES * 4 + 6;
      for (let n = 0; n < written; n++) yield* appendLines(folder, [line(n)]);

      const names = (yield* fs.readDirectory(folder)).toSorted();
      assert.deepStrictEqual(
        names,
        Array.from({ length: KEPT_FILES }, (_, index) =>
          index === 0 ? SERVER_LOG : `${SERVER_LOG}.${index}`,
        ).toSorted(),
      );
      const numbers: Array<number> = [];
      for (const file of logFiles(path, folder).toReversed()) {
        const text = yield* fs.readFileString(file);
        assert.isAtMost(new TextEncoder().encode(text).length, MAX_FILE_BYTES);
        for (const each of text.trimEnd().split("\n")) numbers.push(decodeLine(each).n);
      }
      // The newest lines, in order, with nothing cut: the oldest went first.
      const kept = numbers.length;
      assert.deepStrictEqual(
        numbers,
        Array.from({ length: kept }, (_, index) => written - kept + index),
      );
      assert.isAtLeast(kept, (KEPT_FILES - 1) * 4);
    }),
  );
});
