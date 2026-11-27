// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { run } from "./exportProcess.ts";

/**
 * A stand-in for the server's `export` command: it reads the passphrase from
 * the first line of stdin, as `--passphrase-stdin` does, and leaves stdin
 * open after it; then it writes what it read to `--output` and its report to
 * `--report`, or refuses as the command does when the passphrase is
 * `refuse me`, or writes no report when it is `say nothing`.
 */
const STAND_IN = `
const fs = require("node:fs");
const output = process.argv[process.argv.indexOf("--output") + 1];
const report = process.argv[process.argv.indexOf("--report") + 1];
let held = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  held += chunk;
  if (!held.includes("\\n")) return;
  const passphrase = held.split("\\n")[0];
  if (passphrase === "refuse me") {
    console.log(JSON.stringify({ level: "INFO", message: "Opening the home" }));
    console.error("\\nERROR\\n  A file is already at " + output + ".");
    process.exit(1);
  }
  fs.writeFileSync(output, "export of " + process.env.J3_HOME + " under " + passphrase);
  if (passphrase !== "say nothing") {
    fs.writeFileSync(report, JSON.stringify({
      bots: 2,
      secrets: { _tag: "left-out", reason: "unreadable" },
      linksLeftOut: 1,
      namesLeftOut: Array.from({ length: 25 }, (_, i) => "bots/ana/files/a\\\\" + i),
      attachmentsMissing: 0,
    }));
  }
  process.exit(0);
});
`;

const environment = (home: string): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) kept[name] = value;
  }
  return { ...kept, J3_HOME: home };
};

const standIn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-export-" });
  const entry = path.join(folder, "bin.cjs");
  yield* fs.writeFileString(entry, STAND_IN);
  return {
    folder,
    entry,
    file: path.join(folder, "export.tar.gz"),
    report: path.join(folder, "report.json"),
  };
});

it.effect("gives the export its home and the passphrase, and says what it left out", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { entry, file, report } = yield* standIn;
    const leftOut = yield* run({
      node: process.execPath,
      entry,
      env: environment("/homes/ana"),
      file,
      report,
      passphrase: Redacted.make("a long passphrase for the move"),
    });
    assert.strictEqual(
      yield* fs.readFileString(file),
      "export of /homes/ana under a long passphrase for the move",
    );
    assert.deepStrictEqual(
      { ...leftOut, firstNames: leftOut.firstNames.length },
      { secrets: "unreadable", links: 1, names: 25, firstNames: 20, attachmentsMissing: 0 },
    );
    assert.strictEqual(leftOut.firstNames[0], "bots/ana/files/a\\0");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails with the export's own refusal, not its logs", () =>
  Effect.gen(function* () {
    const { entry, file, report } = yield* standIn;
    const failed = yield* Effect.flip(
      run({
        node: process.execPath,
        entry,
        env: environment("/homes/ana"),
        file,
        report,
        passphrase: Redacted.make("refuse me"),
      }),
    );
    assert.strictEqual(failed.reason, `A file is already at ${file}.`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails, and removes the archive, when the export says nothing of what it holds", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { entry, file, report } = yield* standIn;
    const failed = yield* Effect.flip(
      run({
        node: process.execPath,
        entry,
        env: environment("/homes/ana"),
        file,
        report,
        passphrase: Redacted.make("say nothing"),
      }),
    );
    assert.strictEqual(failed.reason, "The export did not say what it holds.");
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
