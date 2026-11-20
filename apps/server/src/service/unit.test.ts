// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { environmentOf, render, servicePath, type UnitPlan } from "./unit.ts";

const GIB = 1024 ** 3;

const PI: UnitPlan = {
  node: "/home/pi/.local/share/fnm/node-versions/v26.13.1/installation/bin/node",
  entryPoint: "/home/pi/j3-bots/apps/server/dist/bin.mjs",
  home: "/home/pi/.j3-bots",
  searchPath: "/home/pi/.local/bin:/usr/local/bin:/usr/bin:/bin",
  totalMemoryBytes: 4 * GIB,
};

/** The settings of a unit, each with every value it was given, in order. */
const settings = (unit: string) => {
  const found = new Map<string, Array<string>>();
  for (const line of unit.split("\n")) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]]);
  }
  return found;
};

/** `ExecStart=`'s words as systemd reads them, `$$` undone too. */
const command = (value: string) => words(value).map((word) => word.replaceAll("$$", "$"));

/** One setting's words as systemd reads them: quotes grouped, escapes and `%%` undone. */
const words = (value: string) => {
  const result: Array<string> = [];
  let word = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quoted) {
      word += value[++index] ?? "";
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === " " && !quoted) {
      if (started) result.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) result.push(word);
  return result.map((each) => each.replaceAll("%%", "%"));
};

const single = (unit: Map<string, Array<string>>, name: string) => {
  const values = unit.get(name) ?? [];
  assert.lengthOf(values, 1, name);
  return values[0] ?? "";
};

it.effect("runs `serve` with the given Node, in the home, restarted when it fails", () =>
  Effect.gen(function* () {
    const unit = settings(yield* render(PI));
    assert.deepStrictEqual(command(single(unit, "ExecStart")), [PI.node, PI.entryPoint, "serve"]);
    assert.strictEqual(single(unit, "WorkingDirectory"), PI.home);
    assert.sameMembers((unit.get("Environment") ?? []).flatMap(words), [
      `J3_HOME=${PI.home}`,
      `PATH=${PI.searchPath}`,
    ]);
    assert.strictEqual(single(unit, "Restart"), "on-failure");
    assert.strictEqual(single(unit, "WantedBy"), "default.target");
  }),
);

it.effect("leaves a 4 GB Raspberry Pi about 1.6 GB beyond the service's memory", () =>
  Effect.gen(function* () {
    const unit = settings(yield* render(PI));
    const high = /^(\d+)M$/.exec(single(unit, "MemoryHigh"));
    const megabytes = Number(high?.[1]);
    assert.isTrue(megabytes > 2300 && megabytes < 2600, `MemoryHigh=${megabytes}M`);
  }),
);

it.effect("keeps paths with spaces, quotes, percent and dollar signs intact", () =>
  Effect.gen(function* () {
    const plan: UnitPlan = {
      ...PI,
      entryPoint: '/home/pi/my "bots"/100% sure/$HOME/${USER}/bin.mjs',
      home: "/home/pi/J3 data/50%",
      searchPath: "/opt/my tools/bin:/usr/bin",
    };
    const text = yield* render(plan);
    const unit = settings(text);
    assert.deepStrictEqual(command(single(unit, "ExecStart")), [
      plan.node,
      plan.entryPoint,
      "serve",
    ]);
    // What `doctor` reads back from the installed unit.
    assert.strictEqual(environmentOf(text).get("PATH"), plan.searchPath);
    assert.strictEqual(single(unit, "WorkingDirectory").replaceAll("%%", "%"), plan.home);
    assert.sameMembers((unit.get("Environment") ?? []).flatMap(words), [
      `J3_HOME=${plan.home}`,
      `PATH=${plan.searchPath}`,
    ]);
  }),
);

it.effect("refuses values systemd cannot take", () =>
  Effect.gen(function* () {
    for (const plan of [
      { ...PI, node: '/opt/no"de/bin/node' },
      { ...PI, node: "/opt/node\\bin\\node" },
      { ...PI, home: "/home/pi/j3\nExecStartPre=/bin/sh" },
      { ...PI, searchPath: "/usr/bin\n" },
    ]) {
      const exit = yield* render(plan).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
      assert.deepInclude(Option.getOrUndefined(error), { _tag: "UnitValueRefused" });
    }
  }),
);

it.layer(NodeServices.layer)("the service's PATH", (it) => {
  it.effect("names each folder by its real path, and drops the per-session ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const runtime = path.join(root, "run", "user", "1000");
      const node = path.join(root, "fnm", "node-versions", "v26.13.1", "installation", "bin");
      const shell = path.join(runtime, "fnm_multishells", "4242_1700000000000");
      const scratch = path.join(runtime, "scratch");
      yield* fs.makeDirectory(node, { recursive: true });
      yield* fs.makeDirectory(scratch, { recursive: true });
      yield* fs.makeDirectory(path.dirname(shell), { recursive: true });
      yield* fs.symlink(path.dirname(node), shell);

      const searchPath = [path.join(shell, "bin"), scratch, "/usr/bin", "relative/bin", "/usr/bin"];
      assert.strictEqual(
        yield* servicePath(searchPath.join(":"), Option.some(runtime)),
        [node, "/usr/bin"].join(":"),
      );
    }).pipe(Effect.scoped),
  );
});
