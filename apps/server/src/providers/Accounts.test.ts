// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId, ProviderId } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { homeLayout } from "../home/entries.ts";
import * as TestDomain from "../testing/domain.ts";
import { ProviderAccounts } from "./Accounts.ts";

let commands = 0;
const command = () => CommandId.make(`account-command-${++commands}`);

/** The providers the engine was last given. */
const lastGiven = Effect.gen(function* () {
  const lists = yield* (yield* TestEngineControl).providerLists;
  return lists.at(-1) ?? [];
});

it.effect("adds an account of a harness in a home of its own, and the running engine runs it", () =>
  Effect.gen(function* () {
    const accounts = yield* ProviderAccounts;
    const path = yield* Path.Path;
    const { home } = yield* ServerConfig;
    const added = yield* accounts.add({
      commandId: command(),
      harness: "claude-code",
      name: "Claude (work)",
    });
    const given = (yield* lastGiven).find((provider) => provider.id === added);
    assert.deepStrictEqual(given, {
      id: added,
      name: "Claude (work)",
      harness: "claude-code",
      home: homeLayout(path, home).providerHome(added),
      environment: [],
      enabled: true,
      binaryPath: undefined,
      launchArguments: "",
    });
    // The first of each harness stays as every install had it.
    assert.deepStrictEqual(
      (yield* lastGiven).map((provider) => provider.id),
      [ProviderId.make("claude-code"), ProviderId.make("codex"), added],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("adds one account for a command sent again after a lost reply", () =>
  Effect.gen(function* () {
    const accounts = yield* ProviderAccounts;
    const input = { commandId: command(), harness: "codex", name: "Codex (home)" } as const;
    const first = yield* accounts.add(input);
    assert.strictEqual(yield* accounts.add(input), first);
    assert.lengthOf(
      (yield* lastGiven).filter((provider) => provider.harness === "codex"),
      2,
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("turns the first account of a harness off and on, and never removes it", () =>
  Effect.gen(function* () {
    const accounts = yield* ProviderAccounts;
    const first = ProviderId.make("claude-code");
    yield* accounts.setUp({
      commandId: command(),
      providerId: first,
      changes: {
        enabled: false,
        binaryPath: "/opt/claude/bin/claude",
        launchArguments: "--chrome",
      },
    });
    const off = (yield* lastGiven).find((provider) => provider.id === first);
    assert.include(off, {
      enabled: false,
      binaryPath: "/opt/claude/bin/claude",
      launchArguments: "--chrome",
    });
    const refused = yield* accounts
      .remove({ commandId: command(), providerId: first })
      .pipe(Effect.flip);
    assert.deepInclude(refused, { _tag: "Conflict", reason: "provider-not-removable" });
    assert.isTrue((yield* lastGiven).some((provider) => provider.id === first));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("removes an account the operator added, with the sign-in in its home", () =>
  Effect.gen(function* () {
    const accounts = yield* ProviderAccounts;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home } = yield* ServerConfig;
    const added = yield* accounts.add({ commandId: command(), harness: "codex", name: "Codex" });
    const folder = homeLayout(path, home).providerHome(added);
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(path.join(folder, "auth.json"), "{}");
    yield* accounts.remove({ commandId: command(), providerId: added });
    assert.isFalse((yield* lastGiven).some((provider) => provider.id === added));
    assert.isFalse(yield* fs.exists(folder));
    const missing = yield* accounts
      .setUp({ commandId: command(), providerId: added, changes: { enabled: false } })
      .pipe(Effect.flip);
    assert.deepInclude(missing, { _tag: "NotFound", resource: "provider" });
  }).pipe(Effect.provide(TestDomain.layer)),
);
