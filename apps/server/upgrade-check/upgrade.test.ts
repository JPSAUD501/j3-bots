// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- J3 Bots' database is read with node:sqlite, read-only, while the service writes it.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type BotId,
  CommandId,
  type EntryTarget,
  HTTP_PATHS,
  J3Rpcs,
  PairRequest,
  PairResult,
  ReceivedEntry,
  type RoomId,
  RosterItem,
  Routine,
  RoutineRun,
} from "@j3-bots/contracts";
import { databaseMigration, installedRuntimes } from "@j3-bots/engine-t3/testing";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { freePort, runToEnd, searchPathWithoutNode } from "../smoke/host.ts";
import {
  latestPage,
  MIRROR_PUBLIC_KEY,
  mirror,
  releaseArchive,
  releaseFiles,
} from "../smoke/mirror.ts";
import * as AdminClient from "../src/admin/AdminClient.ts";
import type { AdminStatus } from "../src/admin/protocol.ts";
import { HARNESSES } from "../src/engine/harnesses.ts";
import { holdLock } from "@j3-bots/processes";
import { HOME_ENTRIES } from "../src/home/entries.ts";
import { launchedRelease, startedRelease, VERSIONS } from "../src/install/layout.ts";
import { listSnapshots, UPDATE_LOCK } from "../src/install/snapshot.ts";
import { RELEASE_MANIFEST, ReleaseManifest } from "../src/installation.ts";
import { execStartOf } from "../src/service/unit.ts";
import { readRuntimeRecord } from "../src/transition/record.ts";

// The upgrade check: two release archives, A and B, as an operator moves
// between them (docs/operations/releasing.md, "The upgrade check").
//
// A is installed with scripts/install.sh from a local mirror of a release
// page, with its service, and with `scriptedAgent` in its config.json, so the
// service's bots run turns with no model. A device pairs through the admin
// socket and /api/pair; it creates two bots, a room and a routine, and runs a
// reply, an approval and a question. Then `j3-bots update` to B, `update
// --rollback` to A and `update` to B again. After each: every entry, the
// roster, the routine and its runs are what the release that now runs should
// show; the engine reports the database migration it should; the update kept
// both releases, their engines and at most two snapshots, left no rollback
// marked and no lock held, the command and the unit run the same release, and
// `j3-bots doctor` finds nothing wrong but the scripted agent;
// and the bot's next turn runs in the same engine session, with no rotation
// and no session lost. Last, `uninstall --delete-data` removes it all, the
// unit included.
//
// A and B may be built from different commits, and pinned to different
// engines, as long as both speak this checkout's client protocol. Needs
// J3_UPGRADE_FROM and J3_UPGRADE_TO (the two archives), a systemd user manager
// with no j3-bots unit, and the network, to download the engines.

const INSTALL_SCRIPT = `${import.meta.dirname}/../../../scripts/install.sh`;
const SCRIPTED_AGENT = `${import.meta.dirname}/../../../packages/engine-t3/scripted-agent/agent.ts`;
const UNIT = "j3-bots.service";

/** The first start downloads the engine, about 200 MB. */
const FIRST_START_WITHIN = Duration.minutes(10);
/** An update waits up to five minutes for the new release (decision 0016). */
const STARTED_WITHIN = Duration.minutes(6);
const STEP_WITHIN = Duration.minutes(2);
const CHECK_WITHIN = Duration.minutes(45);

const services = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  AdminClient.layer.pipe(Layer.provide(NodeServices.layer)),
);

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest));
const encodeView = Schema.encodeUnknownSync(
  Schema.toCodecJson(
    Schema.Struct({
      roster: Schema.Array(RosterItem),
      entries: Schema.Array(Schema.Array(ReceivedEntry)),
      routines: Schema.Array(Routine),
      runs: Schema.Array(RoutineRun),
    }),
  ),
);

/** The main sessions of a bot, as J3 Bots' database records them. */
const MainSession = Schema.Struct({
  id: Schema.String,
  engine_session_id: Schema.NullOr(Schema.String),
  retired_at: Schema.NullOr(Schema.String),
  lost_at: Schema.NullOr(Schema.String),
  turns: Schema.Number,
});
const decodeMainSessions = Schema.decodeUnknownEffect(Schema.Array(MainSession));
const Count = Schema.Struct({ count: Schema.Number });
const decodeCount = Schema.decodeUnknownEffect(Count);

/** A line of `j3-bots doctor`'s report: its mark and the check's name. */
const DOCTOR_LINE = /^([✓!✗-]) (\S(?:.*?\S)?) {2,}/u;

/** The checks of `j3-bots doctor` an update or a rollback answers for: each must be in its report. */
const DOCTOR_REQUIRED = [
  "Configuration",
  "Snapshot",
  "Server",
  "Engine",
  "Service",
  "Command",
  "Pairing",
  "Scripted agent",
];

/**
 * The checks of `j3-bots doctor` about the machine the check runs on, not the
 * install: the user's groups and keys, what the bot's browser needs of the
 * system (its libraries, fonts and sandbox, which a runner's AppArmor may
 * block), and the harnesses it has and their sign-ins. Every other check must
 * pass, but the scripted agent's warning.
 */
const ABOUT_THE_MACHINE: ReadonlySet<string> = new Set([
  "This user",
  "Browser",
  ...Object.values(HARNESSES).map((harness) => harness.name),
]);

/** One line about an entry, for a failure's message. */
const describe = (entry: ReceivedEntry) => {
  switch (entry._tag) {
    case "message":
      return `${entry.author._tag} said ${JSON.stringify(entry.text)}`;
    case "notice":
      return `notice ${JSON.stringify(entry.notice)}`;
    case "approval":
    case "question":
      return `${entry._tag} ${entry.status._tag}`;
    default:
      return entry._tag;
  }
};

/** Rows of a read of the database at `file`, opened read-only. */
const query = (file: string, sql: string, ...parameters: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      return database.prepare(sql).all(...parameters);
    } finally {
      database.close();
    }
  });

/**
 * Where this user's systemd manager reads its units, and the variables that
 * reach it: the unit a release writes goes there, whatever `HOME` the check
 * gives the install. Refuses a manager that knows a j3-bots unit already.
 */
const userManager = Effect.gen(function* () {
  const shown = yield* runToEnd(ChildProcess.make("systemctl", ["--user", "show-environment"]));
  if (shown.exitCode !== 0) {
    return yield* Effect.die(`No systemd user manager answers: ${shown.output}`);
  }
  const variables = new Map(
    shown.output.split("\n").flatMap((line) => {
      const at = line.indexOf("=");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [];
    }),
  );
  const managerHome = variables.get("HOME");
  const configHome =
    variables.get("XDG_CONFIG_HOME") ??
    (managerHome === undefined ? undefined : `${managerHome}/.config`);
  if (configHome === undefined) {
    return yield* Effect.die("The systemd user manager names no HOME.");
  }
  const known = yield* runToEnd(
    ChildProcess.make("systemctl", ["--user", "list-unit-files", UNIT, "--no-legend"]),
  );
  if (known.output.trim() !== "") {
    return yield* Effect.die(
      `This user has a ${UNIT} already. The check installs one of its own, so it runs only where none is.`,
    );
  }
  return { configHome, unitFile: `${configHome}/systemd/user/${UNIT}` };
});

it.layer(services, { excludeTestServices: true })("upgrade check", (it) => {
  it.effect(
    "an update, its rollback and the update again keep every entry and the bots' engine sessions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const admin = yield* AdminClient.AdminClient;
        const http = yield* HttpClient.HttpClient;
        const from = yield* releaseArchive("J3_UPGRADE_FROM");
        const to = yield* releaseArchive("J3_UPGRADE_TO");
        assert.notStrictEqual(from.version, to.version, "A and B must differ in version.");
        const manager = yield* userManager;

        // A stranger's machine: a home of its own, Node only in the releases.
        const scratch = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "j3-upgrade-" }),
        );
        const home = path.join(scratch, "home");
        yield* fs.makeDirectory(home);
        const install = path.join(home, ".local", "share", "j3-bots");
        const launcher = path.join(home, ".local", "bin", "j3-bots");
        const data = path.join(home, ".j3-bots");
        const database = path.join(data, HOME_ENTRIES.database);
        const socket = path.join(data, HOME_ENTRIES.adminSocket);

        const files = new Map([
          ...releaseFiles(from.version, from.name, from.bytes),
          ...releaseFiles(to.version, to.name, to.bytes),
        ]);
        files.set(
          `/download/v${from.version}/install.sh`,
          yield* fs.readFile(path.resolve(INSTALL_SCRIPT)),
        );
        files.set("/latest", latestPage(`v${to.version}`));
        const site = yield* mirror(files);

        const env: Record<string, string> = {
          PATH: yield* searchPathWithoutNode(path.join(scratch, "commands")),
          HOME: home,
          LANG: "C.UTF-8",
          J3_RELEASE_BASE_URL: site.url,
          J3_RELEASE_PUBLIC_KEY: MIRROR_PUBLIC_KEY,
          // The unit goes where the manager reads it; it runs with `HOME` above.
          XDG_CONFIG_HOME: manager.configHome,
          XDG_RUNTIME_DIR: yield* Config.String("XDG_RUNTIME_DIR"),
        };
        const bus = yield* Config.option(Config.String("DBUS_SESSION_BUS_ADDRESS"));
        if (Option.isSome(bus)) env["DBUS_SESSION_BUS_ADDRESS"] = bus.value;
        const asStranger = { env, extendEnv: false } as const;

        /** `j3-bots <args>` on the installed command, which must succeed. */
        const j3 = Effect.fn("upgradeCheck.j3")(function* (args: ReadonlyArray<string>) {
          const ran = yield* runToEnd(ChildProcess.make(launcher, args, asStranger));
          assert.strictEqual(ran.exitCode, 0, `j3-bots ${args.join(" ")}:\n${ran.output}`);
          return ran.output;
        });

        // Whatever happens, the service and everything it wrote go, before the scratch folder.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (yield* fs.exists(launcher)) {
              yield* runToEnd(
                ChildProcess.make(launcher, ["uninstall", "--delete-data", "--yes"], asStranger),
              );
            }
            if (yield* fs.exists(manager.unitFile)) {
              yield* runToEnd(ChildProcess.make("systemctl", ["--user", "disable", "--now", UNIT]));
              yield* fs.remove(manager.unitFile);
              yield* runToEnd(ChildProcess.make("systemctl", ["--user", "daemon-reload"]));
            }
          }).pipe(Effect.orDie),
        );

        // The scripted agent is set before the first start, as a test install sets it.
        const ports = {
          port: yield* freePort,
          toolPort: yield* freePort,
          enginePort: yield* freePort,
        };
        yield* fs.makeDirectory(data, { mode: 0o700 });
        yield* fs.writeFileString(
          path.join(data, HOME_ENTRIES.config),
          `${JSON.stringify({ host: "127.0.0.1", ...ports, scriptedAgent: path.resolve(SCRIPTED_AGENT) }, null, 2)}\n`,
          { mode: 0o600 },
        );

        /** The manifest of an installed release. */
        const manifestOf = (version: string) =>
          fs
            .readFileString(path.join(install, "versions", version, RELEASE_MANIFEST))
            .pipe(Effect.flatMap(decodeManifest));

        /** The server of `version`, the service's, once its engine runs the pin and offers the scripted agent. */
        const runningRelease = Effect.fn("upgradeCheck.runningRelease")(function* (
          version: string,
          within: Duration.Duration,
        ) {
          const isReady = (status: AdminStatus) =>
            status.version === version &&
            status.engine.state._tag === "ready" &&
            status.engine.providers.some(
              (provider) => provider.id === "scripted" && provider.status._tag === "ready",
            );
          const status = yield* admin.status(socket).pipe(
            Effect.flatMap((found) =>
              Option.isSome(found) && isReady(found.value)
                ? Effect.succeed(found.value)
                : Effect.fail("not ready" as const),
            ),
            Effect.retry(Schedule.spaced("1 second")),
            Effect.timeoutOrElse({
              duration: within,
              orElse: () => Effect.die(`J3 Bots ${version} did not become ready.`),
            }),
          );
          assert.strictEqual(status.engine.pinnedVersion, (yield* manifestOf(version)).engine);
          return status;
        });

        /** A client of the running server, for the scope, as the paired device. */
        const connect = (token: string) =>
          Effect.gen(function* () {
            const protocol = yield* Layer.build(
              RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                  NodeSocket.layerWebSocket(`ws://127.0.0.1:${ports.port}${HTTP_PATHS.rpc}`, {
                    headers: { authorization: `Bearer ${token}` },
                  }),
                ),
                Layer.provide(RpcSerialization.layerJson),
              ),
            );
            return yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));
          });
        type Client = Effect.Success<ReturnType<typeof connect>>;

        /** Every entry of `target`, which must all fit in the first page. */
        const entriesOf = (client: Client, target: EntryTarget) =>
          client["entries.subscribe"]({ target, after: null }).pipe(
            Stream.runHead,
            Effect.flatMap((frame) =>
              Option.isSome(frame) && frame.value._tag === "snapshot"
                ? Effect.succeed(frame.value)
                : Effect.die("entries.subscribe did not start with a snapshot"),
            ),
            Effect.map((snapshot) => {
              assert.isFalse(snapshot.hasOlder, "the check reads one page of entries");
              return snapshot.entries;
            }),
          );

        /** The first entry of `target` that `matches`, as soon as there is one. */
        const awaitEntry = <A extends ReceivedEntry>(
          client: Client,
          target: EntryTarget,
          matches: (entry: ReceivedEntry) => entry is A,
        ) =>
          client["entries.subscribe"]({ target, after: null }).pipe(
            Stream.flatMap((frame) =>
              Stream.fromIterable(frame._tag === "snapshot" ? frame.entries : frame.upsert),
            ),
            Stream.filter(matches),
            Stream.runHead,
            Effect.flatMap((found) => Effect.fromOption(found)),
            Effect.timeoutOrElse({
              duration: STEP_WITHIN,
              orElse: () =>
                Effect.gen(function* () {
                  const entries = yield* entriesOf(client, target);
                  return yield* Effect.die(
                    `The entry expected in ${JSON.stringify(target)} did not come. It holds:\n${entries.map(describe).join("\n")}\n${yield* serverState}`,
                  );
                }),
            }),
          );

        /** What the server's database and engine say, for a failure's message. */
        const serverState = Effect.gen(function* () {
          const rows = (sql: string) =>
            query(database, sql).pipe(Effect.map((found) => JSON.stringify(found)));
          const status = yield* admin.status(socket).pipe(Effect.option);
          return [
            `wakes: ${yield* rows("SELECT bot_id, kind, status, failure_reason FROM wakes")}`,
            `dispatches: ${yield* rows("SELECT bot_id, status, failure_reason, disposition FROM dispatches")}`,
            `sessions: ${yield* rows("SELECT bot_id, purpose, engine_session_id, lost_at, retired_at FROM sessions")}`,
            `engine: ${JSON.stringify(Option.map(Option.flatten(status), (found) => found.engine))}`,
          ].join("\n");
        });

        const botSaid =
          (text: string) =>
          (entry: ReceivedEntry): entry is Extract<ReceivedEntry, { _tag: "message" }> =>
            entry._tag === "message" && entry.author._tag === "bot" && entry.text === text;

        /**
         * Nothing waits or runs: no wake pending or dispatched, which a turn
         * running or held on a card keeps, and no routine run going. A turn's
         * follow-up wake is written in the transaction that ends the turn.
         */
        const quiet = Effect.gen(function* () {
          const open = yield* query(
            database,
            `SELECT (SELECT count(*) FROM wakes WHERE status IN ('pending', 'dispatched'))
              + (SELECT count(*) FROM routine_runs WHERE status = 'running') AS count`,
          ).pipe(Effect.flatMap((rows) => decodeCount(rows[0])));
          if (open.count > 0) return yield* Effect.fail("busy" as const);
        }).pipe(
          Effect.retry(Schedule.spaced("500 millis")),
          Effect.timeoutOrElse({
            duration: STEP_WITHIN,
            orElse: () => Effect.die("The bots did not finish their work."),
          }),
        );

        /** The bot's one main session, live, and how many turns ran in it. */
        const mainSession = Effect.fn("upgradeCheck.mainSession")(function* (botId: BotId) {
          const sessions = yield* query(
            database,
            `SELECT s.id, s.engine_session_id, s.retired_at, s.lost_at,
                (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turns
              FROM sessions s WHERE s.bot_id = ? AND s.purpose = 'main'`,
            botId,
          ).pipe(Effect.flatMap(decodeMainSessions));
          assert.strictEqual(sessions.length, 1, `main sessions: ${JSON.stringify(sessions)}`);
          const [session] = sessions;
          if (session === undefined) return yield* Effect.die("no main session");
          assert.isNotNull(session.engine_session_id);
          assert.isNull(session.retired_at, "the main session was rotated");
          assert.isNull(session.lost_at, "the engine lost the main session");
          return session;
        });

        /** The migration the running engine says its database holds. */
        const engineMigration = databaseMigration(ports.enginePort).pipe(
          Effect.flatMap((found) => Effect.fromOption(found)),
          Effect.catch(() => Effect.die("The engine reports no database migration.")),
        );

        /** The engine release `version` pins, as its `release.json` names it. */
        const pinOf = (version: string) =>
          manifestOf(version).pipe(
            Effect.flatMap((manifest) =>
              manifest.engine === undefined
                ? Effect.die(`J3 Bots ${version}'s release.json names no engine.`)
                : Effect.succeed(manifest.engine),
            ),
          );

        /**
         * The newest snapshot is the one an update from A to B just took,
         * naming both releases' engines: its folder, which no earlier update's is.
         */
        const newSnapshot = Effect.gen(function* () {
          const [newest] = yield* listSnapshots(data);
          if (newest === undefined) return yield* Effect.die("the update kept no snapshot");
          const { from: was, to: is } = newest.manifest;
          assert.strictEqual(was.version, from.version);
          assert.strictEqual(was.engine, yield* pinOf(from.version));
          assert.strictEqual(is.version, to.version);
          assert.strictEqual(is.engine, yield* pinOf(to.version));
          return newest.folder;
        });

        /** Names in `folder`, sorted; none when it does not exist. */
        const namesIn = (folder: string) =>
          fs.readDirectory(folder).pipe(
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
            Effect.map((names) => [...names].sort()),
          );

        /** The home's record names `version` as the release that became ready, by a rollback from `rollbackFrom`. */
        const recorded = Effect.fn("upgradeCheck.recorded")(function* (
          version: string,
          rollbackFrom?: string,
        ) {
          const read = yield* readRuntimeRecord(data);
          assert.strictEqual(read._tag, "recorded", "state/runtime.json");
          if (read._tag !== "recorded") return;
          assert.strictEqual(read.record.version, version, "the recorded release");
          assert.deepStrictEqual(
            read.record.rollback,
            rollbackFrom === undefined ? undefined : { from: rollbackFrom },
            "the recorded rollback",
          );
        });

        /**
         * What an update or a rollback leaves once it has finished: the
         * releases and engines it keeps, at most two snapshots, none of them
         * marked as a rollback not finished, `update.lock` free, the command
         * and the unit on `version`, and a `doctor` that finds nothing wrong
         * with the install but the scripted agent.
         */
        const settled = Effect.fn("upgradeCheck.settled")(function* (
          version: string,
          /** Whether an update has run, which keeps both releases and their engines. */
          updated: boolean,
        ) {
          // What an update keeps (decision 0016), read from disk: pruning that
          // fails only warns, so its exit code says nothing of it.
          const releases = updated ? [from.version, to.version] : [from.version];
          assert.deepStrictEqual(
            yield* namesIn(path.join(install, VERSIONS)),
            [...releases].sort(),
            "versions/",
          );
          const pins = new Set<string>();
          for (const release of releases) pins.add(yield* pinOf(release));
          assert.deepStrictEqual(
            [...(yield* installedRuntimes(path.join(data, HOME_ENTRIES.engine)))].sort(),
            [...pins].sort(),
            "the engine's runtimes",
          );
          const snapshots = yield* listSnapshots(data);
          assert.isAtMost(snapshots.length, 2, "snapshots kept");
          assert.deepStrictEqual(
            (yield* namesIn(path.join(data, HOME_ENTRIES.backups))).filter(
              (name) => name !== UPDATE_LOCK,
            ),
            snapshots.map((snapshot) => path.basename(snapshot.folder)).sort(),
            "backups/ holds the snapshots and the lock only",
          );

          for (const snapshot of snapshots) {
            assert.isTrue(
              Option.isNone(snapshot.restoring),
              `${snapshot.folder} is still marked as a rollback`,
            );
          }
          // No lock file before the first update: none held.
          const updateLock = path.join(data, HOME_ENTRIES.backups, UPDATE_LOCK);
          if (yield* fs.exists(updateLock)) {
            yield* Effect.scoped(holdLock(updateLock, () => "update.lock is still held")).pipe(
              Effect.orDie,
            );
          }

          const release = Option.some(path.join(install, VERSIONS, version));
          assert.deepStrictEqual(yield* launchedRelease(launcher), release, "the command");
          const unit = yield* fs.readFileString(manager.unitFile);
          assert.deepStrictEqual(
            yield* startedRelease(execStartOf(unit), install),
            release,
            "the unit",
          );

          // It exits 1 on a machine whose harnesses are not signed in, which is not the check's.
          const { output: report } = yield* runToEnd(
            ChildProcess.make(launcher, ["doctor"], asStranger),
          );
          const lines = report.split("\n").flatMap((line) => {
            const [, mark, name] = DOCTOR_LINE.exec(line) ?? [];
            return mark === undefined || name === undefined ? [] : [{ mark, name }];
          });
          const named = new Set(lines.map((line) => line.name));
          for (const name of DOCTOR_REQUIRED) {
            assert.isTrue(named.has(name), `doctor says nothing of ${name}:\n${report}`);
          }
          for (const { mark, name } of lines) {
            if (ABOUT_THE_MACHINE.has(name)) continue;
            const expected = name === "Scripted agent" ? "!" : "✓";
            assert.strictEqual(mark, expected, `doctor's ${name}:\n${report}`);
          }
        });

        /** What a run compared at one step, for whoever reads its output. */
        const report = (
          step: string,
          seen: { readonly entries: number; readonly routines: number },
          session: typeof MainSession.Type,
          migration: number,
        ) =>
          Effect.gen(function* () {
            const status = yield* admin.status(socket);
            const engine = Option.match(status, {
              onNone: () => "no server",
              onSome: (found) => `T3 Code ${found.engine.pinnedVersion}`,
            });
            yield* Effect.logInfo(
              `${step}: ${seen.entries} entries and ${seen.routines} routine compared; main session ${session.engine_session_id} with ${session.turns} turns; ${engine}, migration ${migration}`,
            );
          });

        // ---- A, installed as a stranger installs it ------------------------------

        const installed = yield* runToEnd(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'curl -fsSL "$0" | sh -s -- --version "$1"',
              `${site.url}/download/v${from.version}/install.sh`,
              from.version,
            ],
            asStranger,
          ),
        );
        assert.strictEqual(installed.exitCode, 0, installed.output);
        // install.sh's doctor saw the scripted agent, and says what it is.
        assert.include(installed.output, "A scripted agent answers instead of a real model");
        yield* runningRelease(from.version, FIRST_START_WITHIN);

        // A device pairs, as from a browser.
        const grant = yield* admin
          .startPairing(socket, { unlock: false })
          .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
        if (grant._tag !== "granted") return yield* Effect.die("pairing is locked on a new server");
        const { token } = yield* HttpClientRequest.post(
          `http://127.0.0.1:${ports.port}${HTTP_PATHS.pair}`,
        ).pipe(
          HttpClientRequest.schemaBodyJson(PairRequest)({
            code: grant.code,
            name: "Upgrade check",
          }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(PairResult)),
        );

        // Paired, the install has nothing wrong but the scripted agent.
        yield* settled(from.version, false);

        /** In a client of its own, for as long as `use` runs. */
        const withClient = <A, E, R>(use: (client: Client) => Effect.Effect<A, E, R>) =>
          Effect.scoped(Effect.flatMap(connect(token), use));

        /** Everything the operator sees, encoded, to compare one release's with another's. */
        const view = (bots: ReadonlyArray<BotId>, roomId: RoomId) =>
          withClient((client) =>
            Effect.gen(function* () {
              const roster = yield* client["roster.subscribe"]().pipe(
                Stream.runHead,
                Effect.flatMap((frame) =>
                  Option.isSome(frame) && frame.value._tag === "snapshot"
                    ? Effect.succeed(frame.value.items)
                    : Effect.die("roster.subscribe did not start with a snapshot"),
                ),
              );
              const entries: Array<ReadonlyArray<ReceivedEntry>> = [];
              for (const botId of bots) {
                entries.push(yield* entriesOf(client, { _tag: "conversation", botId }));
              }
              entries.push(yield* entriesOf(client, { _tag: "room", roomId }));
              const routines: Array<Routine> = [];
              const runs: Array<RoutineRun> = [];
              for (const botId of bots) {
                const frame = yield* client["routines.subscribe"]({ botId, after: null }).pipe(
                  Stream.runHead,
                );
                if (Option.isNone(frame) || frame.value._tag !== "snapshot") {
                  return yield* Effect.die("routines.subscribe did not start with a snapshot");
                }
                for (const routine of frame.value.routines) {
                  routines.push(routine);
                  const page = yield* client["routine.runs"]({
                    routineId: routine.id,
                    before: null,
                    limit: 50,
                  });
                  runs.push(...page.runs);
                }
              }
              const sorted = [...roster].sort((a, b) =>
                (a._tag === "bot" ? a.bot.id : a.room.id).localeCompare(
                  b._tag === "bot" ? b.bot.id : b.room.id,
                ),
              );
              return {
                encoded: encodeView({ roster: sorted, entries, routines, runs }),
                entries: entries.flat().length,
                routines: routines.length,
              };
            }),
          );

        /**
         * One more turn of the bot after a switch: its reply comes, and it ran
         * in the main session it had, which no rotation replaced and the
         * engine still knows.
         */
        const nextTurn = Effect.fn("upgradeCheck.nextTurn")(function* (
          botId: BotId,
          before: typeof MainSession.Type,
          /** One word: the scripted agent reads a directive's values up to a space. */
          text: string,
        ) {
          const target = { _tag: "conversation", botId } as const;
          yield* withClient((client) =>
            Effect.gen(function* () {
              yield* client["message.send"]({
                commandId: CommandId.make(`upgrade-check-${text}`),
                target,
                text: `[[script:speak text=${text}]]`,
                attachments: [],
              });
              yield* awaitEntry(client, target, botSaid(text));
            }),
          );
          yield* quiet;
          const after = yield* mainSession(botId);
          assert.strictEqual(after.id, before.id, "the bot's main session changed");
          assert.strictEqual(after.engine_session_id, before.engine_session_id);
          assert.isAbove(after.turns, before.turns, "the turn did not run in the main session");
          const entries = yield* withClient((client) => entriesOf(client, target));
          assert.isFalse(
            entries.some(
              (entry) => entry._tag === "notice" && entry.notice._tag === "session-lost",
            ),
            "a session-lost notice",
          );
          return after;
        });

        // ---- What an operator does on A ------------------------------------------

        const made = yield* withClient((client) =>
          Effect.gen(function* () {
            const keeper = yield* client["bot.create"]({
              commandId: CommandId.make("upgrade-check-keeper"),
              name: "Keeper",
              // Approvals reach the operator only in this mode.
              permissionMode: "supervised",
            });
            const second = yield* client["bot.create"]({
              commandId: CommandId.make("upgrade-check-second"),
              name: "Second",
            });
            // Each new bot opens its conversation with a turn of its own: a
            // message sent meanwhile would steer into it.
            yield* quiet;
            const target = { _tag: "conversation", botId: keeper.id } as const;
            const send = (label: string, text: string) =>
              client["message.send"]({
                commandId: CommandId.make(`upgrade-check-${label}`),
                target,
                text,
                attachments: [],
              });

            // A reply.
            yield* send("reply", "[[script:speak text=before-update]]");
            yield* awaitEntry(client, target, botSaid("before-update"));
            yield* quiet;

            // An approval, allowed once.
            yield* send("approval", "[[script:approval]]");
            const approval = yield* awaitEntry(
              client,
              target,
              (entry): entry is Extract<ReceivedEntry, { _tag: "approval" }> =>
                entry._tag === "approval" && entry.status._tag === "pending",
            );
            yield* client["card.answer"]({
              commandId: CommandId.make("upgrade-check-approve"),
              entryId: approval.id,
              answer: { _tag: "approval", decision: "allow-once" },
            });
            yield* quiet;

            // A question, answered.
            yield* send("question", "[[script:question]]");
            const asked = yield* awaitEntry(
              client,
              target,
              (entry): entry is Extract<ReceivedEntry, { _tag: "question" }> =>
                entry._tag === "question" && entry.status._tag === "pending",
            );
            const [question] = asked.questions;
            const red = question.options.find((option) => option.label === "Red");
            if (red === undefined) return yield* Effect.die("the question offers no Red");
            yield* client["card.answer"]({
              commandId: CommandId.make("upgrade-check-answer"),
              entryId: asked.id,
              answer: {
                _tag: "question",
                answers: { [question.id]: { optionIds: [red.id], text: null } },
              },
            });
            yield* quiet;

            // A room, where the member the message mentions answers.
            const room = yield* client["room.create"]({
              commandId: CommandId.make("upgrade-check-room"),
              name: "Upgrade room",
              members: [keeper.id, second.id],
            });
            const inRoom = { _tag: "room", roomId: room.id } as const;
            yield* client["message.send"]({
              commandId: CommandId.make("upgrade-check-room-message"),
              target: inRoom,
              text: "[[script:speak text=in-the-room]]",
              attachments: [],
              mentions: { _tag: "bots", ids: [keeper.id] },
            });
            yield* awaitEntry(client, inRoom, botSaid("in-the-room"));
            yield* quiet;

            // A routine, run once.
            const routine = yield* client["routine.create"]({
              commandId: CommandId.make("upgrade-check-routine"),
              botId: keeper.id,
              name: "Report",
              instruction: "[[script:speak text=routine-ran]]",
              trigger: { _tag: "webhook" },
            });
            yield* client["routine.run"]({
              commandId: CommandId.make("upgrade-check-routine-run"),
              routineId: routine.id,
            });
            yield* quiet;
            const { runs } = yield* client["routine.runs"]({
              routineId: routine.id,
              before: null,
              limit: 50,
            });
            assert.lengthOf(runs, 1);
            assert.isNotNull(runs[0]?.finishedAt ?? null, "the routine's run did not finish");

            const entries = yield* entriesOf(client, target);
            const decided = entries.find((entry) => entry.id === approval.id);
            assert.deepInclude(decided, { status: { _tag: "decided", decision: "allow-once" } });
            const answered = entries.find((entry) => entry.id === asked.id);
            assert.strictEqual(answered?._tag === "question" && answered.status._tag, "answered");
            return {
              bots: [keeper.id, second.id],
              keeper: keeper.id,
              second: second.id,
              room: room.id,
            };
          }),
        );

        const onA = {
          view: yield* view(made.bots, made.room),
          session: yield* mainSession(made.keeper),
          second: yield* mainSession(made.second),
          migration: yield* engineMigration,
        };

        /** Second took no turn since A: it still has the main session it had, live, as it was. */
        const secondKept = mainSession(made.second).pipe(
          Effect.map((session) => assert.deepStrictEqual(session, onA.second, "Second's session")),
        );
        yield* report(`${from.version} before the update`, onA.view, onA.session, onA.migration);

        // ---- Update to B ---------------------------------------------------------

        yield* j3(["update", "--yes"]);
        yield* runningRelease(to.version, STARTED_WITHIN);
        yield* settled(to.version, true);
        yield* recorded(to.version);
        assert.deepStrictEqual((yield* view(made.bots, made.room)).encoded, onA.view.encoded);
        const firstSnapshot = yield* newSnapshot;
        yield* secondKept;
        const migrationB = yield* engineMigration;
        assert.isAtLeast(migrationB, onA.migration);
        const onB = yield* nextTurn(made.keeper, onA.session, "after-update");
        yield* report(`${to.version} after the update`, onA.view, onB, migrationB);

        // ---- Rollback to A -------------------------------------------------------

        yield* j3(["update", "--rollback", "--yes"]);
        yield* runningRelease(from.version, STARTED_WITHIN);
        yield* settled(from.version, true);
        yield* recorded(from.version, to.version);
        assert.deepStrictEqual((yield* view(made.bots, made.room)).encoded, onA.view.encoded);
        assert.strictEqual(yield* engineMigration, onA.migration);
        yield* secondKept;
        const rolledBack = yield* nextTurn(made.keeper, onA.session, "after-rollback");
        const onA2 = { view: yield* view(made.bots, made.room), session: rolledBack };
        yield* report(`${from.version} after the rollback`, onA2.view, rolledBack, onA.migration);

        // ---- Update to B again ---------------------------------------------------

        yield* j3(["update", "--yes"]);
        yield* runningRelease(to.version, STARTED_WITHIN);
        yield* settled(to.version, true);
        yield* recorded(to.version);
        assert.deepStrictEqual((yield* view(made.bots, made.room)).encoded, onA2.view.encoded);
        assert.notStrictEqual(
          yield* newSnapshot,
          firstSnapshot,
          "the second update took no snapshot",
        );
        yield* secondKept;
        assert.strictEqual(yield* engineMigration, migrationB);
        const again = yield* nextTurn(made.keeper, onA2.session, "forward-again");
        yield* report(`${to.version} after the update again`, onA2.view, again, migrationB);

        // ---- Nothing left behind --------------------------------------------------

        yield* j3(["uninstall", "--delete-data", "--yes"]);
        assert.isFalse(yield* fs.exists(manager.unitFile), "the unit is still there");
        assert.isFalse(yield* fs.exists(install));
        assert.isFalse(yield* fs.exists(data));
        const units = yield* runToEnd(
          ChildProcess.make("systemctl", ["--user", "list-units", UNIT, "--all", "--no-legend"]),
        );
        assert.strictEqual(units.output.trim(), "", units.output);
      }).pipe(Effect.scoped),
    Duration.toMillis(CHECK_WITHIN),
  );
});
