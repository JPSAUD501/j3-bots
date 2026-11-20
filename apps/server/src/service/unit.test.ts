// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { render, type UnitPlan } from "./unit.ts";

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
    assert.deepStrictEqual(words(single(unit, "ExecStart")), [PI.node, PI.entryPoint, "serve"]);
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

it.effect("keeps paths with spaces, quotes and percent signs intact", () =>
  Effect.gen(function* () {
    const plan: UnitPlan = {
      ...PI,
      entryPoint: '/home/pi/my "bots"/100% sure/bin.mjs',
      home: "/home/pi/J3 data/50%",
      searchPath: "/opt/my tools/bin:/usr/bin",
    };
    const unit = settings(yield* render(plan));
    assert.deepStrictEqual(words(single(unit, "ExecStart")), [plan.node, plan.entryPoint, "serve"]);
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
