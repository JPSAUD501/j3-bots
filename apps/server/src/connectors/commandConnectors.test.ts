// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The folder a command runs in is the system's temporary one.
import * as NodeOs from "node:os";
import { assert, describe, it } from "@effect/vitest";
import {
  alive,
  eventually,
  OPERATOR_SECRET,
  SERVER_ONLY,
  serverEnvironment,
  STDIO_SERVER,
} from "@j3-bots/connectors/testing/stdio";
import {
  CommandId,
  type CommandError,
  type CommandLine,
  type Connector,
  ConnectorId,
  EnvName,
  FieldKey,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { Vault } from "../vault/Vault.ts";
import { CommandReach, Connectors } from "./Connectors.ts";
import { vaultIdOf } from "./credentials.ts";

const ID = ConnectorId.make("conn_c0mmand0123456789");
const PASSWORD = Redacted.make("correct horse battery");
/** An argument that carries a key, as some servers take one. */
const ARG_SECRET = "--token=arg-secret-77665544";

const logged: Array<string> = [];
const domain = TestDomain.layer.pipe(
  Layer.provide(
    Layer.succeed(CommandReach, {
      platform: process.platform,
      environment: serverEnvironment,
      cwd: NodeOs.tmpdir(),
      capacity: 4,
      idle: Duration.minutes(1),
      backoff: {
        initial: Duration.millis(100),
        max: Duration.seconds(1),
        stable: Duration.seconds(30),
      },
      restarts: 2,
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Logger.layer([Logger.map(Logger.formatJson, (line) => logged.push(line))]),
      Layer.succeed(References.MinimumLogLevel, "All"),
    ),
  ),
);

const command = (args: ReadonlyArray<string>, secret = OPERATOR_SECRET): CommandLine => ({
  command: process.execPath,
  args: [STDIO_SERVER, ...args].map((arg) => Redacted.make(arg)),
  env: [{ name: EnvName.make("FIXTURE_SECRET"), value: Redacted.make(secret) }],
});

/** Two bots, and the fixture server added as a command connector only the first may use. */
const setUp = Effect.gen(function* () {
  const vault = yield* Vault;
  yield* vault.setup(PASSWORD);
  const bots = yield* Bots;
  const ana = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });
  const bea = yield* bots.create({ commandId: CommandId.make("bea"), draft: { name: "Bea" } });
  const connectors = yield* Connectors;
  const added = yield* connectors.add({
    id: ID,
    source: { _tag: "command", name: "Notes", ...command([ARG_SECRET]) },
    grant: { _tag: "bots", ids: [ana.id] },
    by: { _tag: "operator" },
  });
  return { connectors, added, ana: ana.id, bea: bea.id };
});

/** The connector once `predicate` holds of it, from `connectors.subscribe`. */
const awaitConnector = (predicate: (connector: Connector) => boolean) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const found = yield* connectors.subscribe.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(event._tag === "snapshot" ? event.connectors : event.upsert),
      ),
      Stream.filter(predicate),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

const listed = (connector: Connector) =>
  connector.status._tag === "connected" && connector.tools.length > 0;

const invalidOf = (error: CommandError) => (error._tag === "Invalid" ? error.reason : null);

/** Starts, talks to and stops real processes. */
const SLOW = 30_000;

describe("Connectors started by command", () => {
  it.live(
    "runs the command for the bots it is granted, with only the environment it was given, its secrets kept from all",
    () =>
      Effect.gen(function* () {
        logged.length = 0;
        const { connectors, added, ana, bea } = yield* setUp;
        assert.deepStrictEqual(added.transport, { _tag: "command", program: process.execPath });
        assert.deepStrictEqual(
          added.fields.map((field) => [field.key, field.secret]),
          [["FIXTURE_SECRET", true]],
        );
        const connector = yield* awaitConnector(listed);

        const offered = (yield* connectors.toolsFor(ana)).map((tool) => tool.name);
        assert.includeMembers(offered, ["notes__echo", "notes__environment", "notes__whoami"]);
        assert.deepStrictEqual(yield* connectors.toolsFor(bea), []);

        const call = (name: string, args: Readonly<Record<string, unknown>> = {}) =>
          connectors.call({ botId: ana, name: `notes__${name}`, arguments: args });
        const echoed = yield* call("echo", { name: "FIXTURE_SECRET" });
        assert.isFalse(echoed.isError);
        assert.include(echoed.text, "[redacted]");
        const environment = yield* call("environment");
        assert.include(environment.text, "FIXTURE_SECRET");
        assert.notInclude(environment.text, SERVER_ONLY);

        const seen = JSON.stringify([connector, echoed, yield* connectors.toolsFor(ana), logged]);
        assert.notInclude(seen, OPERATOR_SECRET);
        assert.notInclude(seen, "arg-secret-77665544");

        const pid = Number((yield* call("whoami")).text.match(/^(\d+)$/m)?.[1] ?? Number.NaN);
        assert.isTrue(alive(pid));
        yield* connectors.remove({ commandId: CommandId.make("remove"), connectorId: ID });
        assert.deepStrictEqual(yield* connectors.toolsFor(ana), []);
        yield* eventually(Effect.sync(() => !alive(pid)));
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "refuses a package launcher with no exact version, and a variable named twice",
    () =>
      Effect.gen(function* () {
        const vault = yield* Vault;
        yield* vault.setup(PASSWORD);
        const connectors = yield* Connectors;
        const add = (source: CommandLine) =>
          Effect.flip(
            connectors.add({
              id: ID,
              source: { _tag: "command", name: "Memory", ...source },
              grant: { _tag: "all-bots" },
              by: { _tag: "operator" },
            }),
          ).pipe(Effect.map(invalidOf));

        assert.strictEqual(
          yield* add({
            command: "npx",
            args: [Redacted.make("-y"), Redacted.make("server-memory@latest")],
            env: [],
          }),
          "command-unpinned",
        );
        assert.strictEqual(
          yield* add({ command: "uvx", args: [Redacted.make("mcp-server-fetch")], env: [] }),
          "command-unpinned",
        );
        assert.strictEqual(
          yield* add({
            ...command([]),
            env: [
              { name: EnvName.make("TOKEN"), value: Redacted.make("one") },
              { name: EnvName.make("token"), value: Redacted.make("two") },
            ],
          }),
          "connector-fields",
        );
        // The search path chooses which program runs, and a value can change with no confirmation.
        assert.strictEqual(
          yield* add({
            ...command([]),
            env: [{ name: EnvName.make("Path"), value: Redacted.make("/tmp/elsewhere") }],
          }),
          "connector-fields",
        );
        // Nothing of a refused command was kept.
        assert.isTrue(Option.isNone(yield* vault.connectorSecrets.get(vaultIdOf(ID))));
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "starts the command again with new values, and holds the tools a new command line adds for review",
    () =>
      Effect.gen(function* () {
        const { connectors, ana } = yield* setUp;
        yield* awaitConnector(listed);
        const whoami = connectors
          .call({ botId: ana, name: "notes__whoami", arguments: {} })
          .pipe(Effect.map((answer) => Number(answer.text.match(/^(\d+)$/m)?.[1] ?? Number.NaN)));
        const first = yield* whoami;

        // Only a variable the command was given may be given a new value.
        const unknown = yield* Effect.flip(
          connectors.update({
            by: { _tag: "operator" },
            connectorId: ID,
            values: [{ key: FieldKey.make("OTHER"), value: Redacted.make("x") }],
          }),
        );
        assert.strictEqual(invalidOf(unknown), "connector-fields");
        yield* connectors.update({
          by: { _tag: "operator" },
          connectorId: ID,
          values: [
            { key: FieldKey.make("FIXTURE_SECRET"), value: Redacted.make("new-secret-8899") },
          ],
        });
        // Its process stopped with the old value; the next call starts one with the new.
        yield* eventually(Effect.sync(() => !alive(first)));
        const second = yield* whoami;
        assert.notStrictEqual(second, first);
        const echoed = yield* connectors.call({
          botId: ana,
          name: "notes__echo",
          arguments: { name: "FIXTURE_SECRET" },
        });
        assert.notInclude(echoed.text, "new-secret-8899");

        // A command line the operator confirmed again: the tool it adds waits on them.
        yield* connectors.update({
          by: { _tag: "operator" },
          connectorId: ID,
          command: command(["--tool", "extra"]),
        });
        const reviewed = yield* awaitConnector((connector) => connector.review !== null);
        assert.deepStrictEqual(
          reviewed.review?.changes.map((change) => [change._tag, change.tool.name]),
          [["added", "extra"]],
        );
        assert.notInclude(
          (yield* connectors.toolsFor(ana)).map((tool) => tool.name),
          "notes__extra",
        );
        yield* eventually(Effect.sync(() => !alive(second)));
        const held = yield* connectors.call({ botId: ana, name: "notes__extra", arguments: {} });
        assert.isTrue(held.isError);

        const unpinned = yield* Effect.flip(
          connectors.update({
            by: { _tag: "operator" },
            connectorId: ID,
            command: { command: "npx", args: [Redacted.make("server-memory")], env: [] },
          }),
        );
        assert.strictEqual(invalidOf(unpinned), "command-unpinned");
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );
});
