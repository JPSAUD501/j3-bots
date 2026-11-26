// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- an import's mark names its archive by the manifest's SHA-256, taken here with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, it } from "@effect/vitest";
import { type BotId, DeviceId, SecretId, SecretName } from "@j3-bots/contracts";
import type { SessionId } from "@j3-bots/engine-t3";
import { sharedSkills } from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { homeLayout } from "../home/entries.ts";
import { Routines } from "../routines/Routines.ts";
import { Secrets } from "../secrets/Secrets.ts";
import * as TestDatabase from "../testing/database.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  nextTurn,
  noticesOf,
  sendToBot,
  sessionAfter,
  until,
} from "../testing/turns.ts";
import { ARCHIVED_DATABASE, MANIFEST, ManifestJson } from "./archive.ts";
import { exportHome } from "./Export.ts";
import { importHome } from "./Import.ts";
import { importMark } from "./importMark.ts";
import { type BytesEntry, unpack, writeTarGz } from "./tar.ts";

/** Two servers start, and the passphrase's key is derived twice or more, at 128 MiB each. */
const MOVE_TIMEOUT = 60_000;

const PASSPHRASE = Redacted.make("a long passphrase for the move");
const WRONG = Redacted.make("not the passphrase at all");
const SECRET_VALUE = "weather-token-0f3a9c";
const SECRET = SecretId.make("sec_0000000000000001");
const DEVICE = DeviceId.make("device-laptop");

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The whole domain on the home `home`, which outlives it. */
const serverAt = (home: string) => TestDomain.layerOver(TestDatabase.layerAt(home), new Map());

const exportTo = (home: string, file: string) =>
  exportHome({ home, file, passphrase: () => Effect.succeed(PASSPHRASE) });

const importFrom = (
  home: string,
  file: string,
  options: { readonly replace?: boolean; readonly passphrase?: Redacted.Redacted<string> } = {},
) =>
  importHome({
    home,
    file,
    replace: options.replace ?? false,
    passphrase: { ask: Effect.succeed(options.passphrase ?? PASSPHRASE), attempts: 1 },
  });

/** The failure's tag, or null when it succeeded. */
const failedWith = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) && Schema.is(Schema.Struct({ _tag: Schema.String }))(error.value)
    ? error.value
    : null;
};

/** Every entry of the archive at `file`, its bytes in memory. */
const entriesOf = (file: string) =>
  unpack(file, () => ({ _tag: "memory", limit: 64 * 1024 * 1024 })).pipe(
    Effect.map((all) =>
      all.map(({ name, bytes }): BytesEntry => ({
        _tag: "bytes",
        name,
        bytes: bytes ?? new Uint8Array(),
      })),
    ),
  );

/** The mark an import of the archive at `file` leaves while it puts it in place. */
const markOf = (file: string) =>
  Effect.gen(function* () {
    const [manifest] = yield* entriesOf(file);
    return JSON.stringify({ archive: sha256(manifest?.bytes ?? new Uint8Array()) });
  });

/**
 * Writes the archive at `file` again at `to`, with its database as `change`
 * leaves it, and a manifest that lists it: as only someone who forged it
 * would.
 */
const forgeDatabase = (
  file: string,
  to: string,
  change: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError.SqlError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* entriesOf(file);
    const database = entries.find(({ name }) => name === ARCHIVED_DATABASE);
    if (database === undefined) return yield* Effect.die("no database");
    const scratch = path.join(yield* fs.makeTempDirectoryScoped(), "j3.sqlite");
    yield* fs.writeFile(scratch, database.bytes);
    yield* Effect.scoped(
      SqliteClient.make({ filename: scratch }).pipe(
        Effect.provide(Reactivity.layer),
        Effect.flatMap((sql) =>
          change(sql).pipe(Effect.andThen(sql`PRAGMA journal_mode = DELETE`)),
        ),
      ),
    ).pipe(Effect.orDie);
    const bytes = yield* fs.readFile(scratch);
    const [first, ...rest] = entries;
    if (first === undefined) return yield* Effect.die("no manifest");
    const manifest = yield* Schema.decodeEffect(ManifestJson)(
      Buffer.from(first.bytes).toString("utf8"),
    ).pipe(Effect.orDie);
    const text = yield* Schema.encodeEffect(ManifestJson)({
      ...manifest,
      files: manifest.files.map((listed) =>
        listed.path === ARCHIVED_DATABASE
          ? { ...listed, size: bytes.length, sha256: sha256(bytes) }
          : listed,
      ),
    }).pipe(Effect.orDie);
    yield* writeTarGz(
      to,
      [
        { ...first, bytes: new TextEncoder().encode(text) },
        ...rest.map((entry) => (entry.name === ARCHIVED_DATABASE ? { ...entry, bytes } : entry)),
      ],
      DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-01T00:00:00Z")),
    );
  });

/** Writes the archive at `file` again at `to`, each entry as `change` makes it. */
const rewrite = (
  file: string,
  to: string,
  change: (entry: BytesEntry) => Effect.Effect<BytesEntry>,
) =>
  Effect.gen(function* () {
    const changed = yield* Effect.forEach(yield* entriesOf(file), change);
    yield* writeTarGz(to, changed, DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-01T00:00:00Z")));
  });

/**
 * A home where Ana has a conversation, a session, a memory file and a value
 * secret, a webhook routine made as a client makes it, a shared skill, and a paired device: what
 * moving it must carry or leave behind.
 */
const populatedHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const layout = homeLayout(path, home);
  const before = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ana = yield* createBot("Ana");
    const session = yield* engineSession(ana.id);
    const message = yield* sendToBot(ana.id, "Remember the blue door");
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    yield* (yield* Secrets).add({
      id: SECRET,
      name: SecretName.make("weather-api"),
      draft: { _tag: "value", value: Redacted.make(SECRET_VALUE) },
      access: { _tag: "every-bot" },
    });
    yield* sql`
      INSERT INTO devices (id, name, token_hash, paired_at)
      VALUES ('device-phone', 'Phone', 'token-hash-of-the-phone', '2026-11-01T00:00:00.000Z')
    `;
    // Made as a client makes it, so its receipt holds its address too.
    const routine = yield* (yield* Routines).create({
      commandId: command(),
      botId: ana.id,
      draft: { name: "Deploys", instruction: "Say what shipped", trigger: { _tag: "webhook" } },
      author: { _tag: "operator" },
    });
    const [hook] = yield* sql<{ readonly webhook_secret: string }>`
      SELECT webhook_secret FROM routines WHERE id = ${routine.id}
    `;
    if (hook === undefined) return yield* Effect.die("A webhook routine has a secret");
    return { ana: ana.id, session, routine: routine.id, webhookSecret: hook.webhook_secret };
  }).pipe(Effect.provide(serverAt(home)));
  yield* fs.writeFileString(
    path.join(layout.botMemory(before.ana), "notes.md"),
    "The blue door.\n",
  );
  yield* fs.makeDirectory(path.join(layout.sharedSkills, "greet"), { recursive: true });
  yield* fs.writeFileString(path.join(layout.sharedSkills, "greet", "SKILL.md"), "# Greet\n");
  return { home, ...before };
});

/** What the database holds of the session the engine knew as `session`. */
const lostAt = (session: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly lost_at: string | null }>`
      SELECT lost_at FROM sessions WHERE engine_session_id = ${session}
    `;
    return row?.lost_at ?? null;
  });

const workspaceOf = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly workspace_path: string }>`
      SELECT workspace_path FROM bots WHERE id = ${botId}
    `;
    return row?.workspace_path ?? null;
  });

it.effect(
  "moves the bots, their conversations, memory and secrets to another home, where each starts a new session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      const exported = yield* exportTo(from.home, file);
      assert.strictEqual(exported.bots, 1);
      assert.deepInclude(exported.secrets, { _tag: "sealed", records: 1 });
      // Only its owner reads it: on Windows, by the access list of the private
      // folder it was written in, which has no mode bits to show.
      if (process.platform !== "win32") {
        assert.strictEqual(((yield* fs.stat(file)).mode & 0o777).toString(8), "600");
      }

      const to = yield* fs.makeTempDirectoryScoped();
      const imported = yield* importFrom(to, file);
      assert.strictEqual(imported.bots, 1);
      assert.isFalse(imported.replaced);
      assert.isFalse(yield* fs.exists(path.join(to, "state", "import")));
      const layout = homeLayout(path, to);
      assert.strictEqual(
        yield* fs.readFileString(path.join(layout.botMemory(from.ana), "notes.md")),
        "The blue door.\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(layout.sharedSkills, "greet", "SKILL.md")),
        "# Greet\n",
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(yield* workspaceOf(from.ana), layout.workspace(from.ana));
        const [devices] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM devices`;
        assert.strictEqual(devices?.n, 0);
        const texts = (yield* conversation(from.ana)).flatMap((entry) =>
          entry._tag === "message" ? [entry.text] : [],
        );
        assert.include(texts, "Remember the blue door");
        const revealed = yield* (yield* Secrets).reveal({
          id: SECRET,
          field: "value",
          deviceId: DEVICE,
        });
        assert.strictEqual(Redacted.value(revealed), SECRET_VALUE);
        // The webhook works here, under a secret of its own.
        const [hook] = yield* sql<{ readonly webhook_secret: string | null }>`
          SELECT webhook_secret FROM routines WHERE id = ${from.routine}
        `;
        assert.isString(hook?.webhook_secret);
        assert.notStrictEqual(hook?.webhook_secret, from.webhookSecret);

        // The engine here never had Ana's session: the first start finds it
        // lost, and she goes on in a new one.
        yield* until(lostAt(from.session).pipe(Effect.map((lost) => lost !== null)));
        assert.include(yield* noticesOf(from.ana), "session-lost");
        const message = yield* sendToBot(from.ana, "Where were we?");
        yield* nextTurn(from.ana);
        yield* deliveryIs(message, "delivered");
        yield* sessionAfter(from.ana, from.session);
      }).pipe(Effect.provide(serverAt(to)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "never writes a secret's value or a webhook's secret, in the archive, a log or an error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logged: Array<string> = [];
      const capture = Logger.layer([
        Logger.map(Logger.formatJson, (line) => {
          logged.push(line);
        }),
      ]);
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file).pipe(Effect.provide(capture));
      for (const { name, bytes } of yield* entriesOf(file)) {
        assert.notInclude(Buffer.from(bytes).toString("latin1"), SECRET_VALUE, name);
        assert.notInclude(Buffer.from(bytes).toString("latin1"), from.webhookSecret, name);
      }

      const to = yield* fs.makeTempDirectoryScoped();
      const wrong = yield* Effect.exit(
        importFrom(to, file, { passphrase: WRONG }).pipe(Effect.provide(capture)),
      );
      assert.strictEqual(failedWith(wrong)?._tag, "WrongPassphrase");
      if (Exit.isFailure(wrong)) assert.notInclude(Cause.pretty(wrong.cause), SECRET_VALUE);
      yield* importFrom(to, file).pipe(Effect.provide(capture));
      // The first start there opens the secrets and finds the session lost.
      yield* Effect.gen(function* () {
        assert.lengthOf(yield* (yield* Secrets).list, 1);
        yield* until(lostAt(from.session).pipe(Effect.map((lost) => lost !== null)));
      }).pipe(Effect.provide(serverAt(to).pipe(Layer.provide(capture))));
      for (const line of logged) assert.notInclude(line, SECRET_VALUE);
      assert.isAbove(logged.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "leaves the home as it was when the passphrase is wrong",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file);

      const to = yield* fs.makeTempDirectoryScoped();
      const exit = yield* Effect.exit(importFrom(to, file, { passphrase: WRONG }));
      assert.strictEqual(failedWith(exit)?._tag, "WrongPassphrase");
      // Nothing but the lock that kept a server off it while the import ran.
      assert.deepStrictEqual(
        (yield* fs.readDirectory(to)).filter((entry) => entry !== "server.lock"),
        ["state"],
      );
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(to, "state")), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "refuses a home that holds bots unless asked to replace them, and then holds only the export's",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file);

      const to = yield* populatedHome;
      const refused = yield* Effect.exit(importFrom(to.home, file));
      assert.deepInclude(failedWith(refused), { _tag: "HomeInUse", bots: 1, secrets: true });

      const replaced = yield* importFrom(to.home, file, { replace: true });
      assert.isTrue(replaced.replaced);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const bots = yield* sql<{ readonly id: string }>`SELECT id FROM bots`;
        assert.deepStrictEqual(
          bots.map(({ id }) => id),
          [from.ana],
        );
      }).pipe(Effect.provide(serverAt(to.home)));
      assert.isFalse(yield* fs.exists(homeLayout(path, to.home).workspace(to.ana)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "refuses an archive a newer release wrote, or one changed after the export",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const folder = yield* fs.makeTempDirectoryScoped();
      const file = path.join(folder, "export.tar.gz");
      yield* exportTo(from.home, file);
      const to = yield* fs.makeTempDirectoryScoped();

      const newer = path.join(folder, "newer.tar.gz");
      yield* rewrite(file, newer, (entry) =>
        entry.name !== MANIFEST
          ? Effect.succeed(entry)
          : Effect.gen(function* () {
              const manifest = yield* Schema.decodeEffect(ManifestJson)(
                Buffer.from(entry.bytes).toString("utf8"),
              );
              const text = yield* Schema.encodeEffect(ManifestJson)({
                ...manifest,
                // A newer release with no new migration is refused all the same.
                version: "99.0.0",
              });
              return { ...entry, bytes: new TextEncoder().encode(text) };
            }).pipe(Effect.orDie),
      );
      assert.deepInclude(failedWith(yield* Effect.exit(importFrom(to, newer))), {
        _tag: "ExportRefused",
        reason: "newer",
        detail: "99.0.0",
      });

      const changed = path.join(folder, "changed.tar.gz");
      yield* rewrite(file, changed, (entry) =>
        Effect.succeed(
          entry.name.endsWith("/notes.md")
            ? { ...entry, bytes: new TextEncoder().encode("The red door.\n") }
            : entry,
        ),
      );
      assert.deepInclude(failedWith(yield* Effect.exit(importFrom(to, changed))), {
        _tag: "ExportRefused",
        reason: "damaged",
      });
      assert.isFalse(yield* fs.exists(path.join(to, "j3.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "refuses to export a home an import stopped in, which the next import finishes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file);

      // Stopped after its mark, with this home's own bot still in place.
      const to = yield* populatedHome;
      yield* fs.makeDirectory(path.dirname(importMark(path, to.home)), { recursive: true });
      yield* fs.writeFileString(importMark(path, to.home), yield* markOf(file));
      const export_ = yield* Effect.exit(exportTo(to.home, path.join(to.home, "again.tar.gz")));
      assert.strictEqual(failedWith(export_)?._tag, "ImportUnfinished");

      // Another export is put there only when asked.
      const other = path.join(yield* fs.makeTempDirectoryScoped(), "other.tar.gz");
      yield* exportTo((yield* populatedHome).home, other);
      const another = yield* Effect.exit(importFrom(to.home, other));
      assert.strictEqual(failedWith(another)?._tag, "AnotherImportUnfinished");

      // The import of the same export finishes it, with no --replace: the home is part one, part the other.
      yield* importFrom(to.home, file);
      assert.isFalse(yield* fs.exists(importMark(path, to.home)));
      const exported = yield* exportTo(to.home, path.join(to.home, "again.tar.gz"));
      assert.strictEqual(exported.bots, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "refuses a home that keeps a deleted bot's files unless asked, but not one with only the shipped skills",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file);

      const kept = yield* fs.makeTempDirectoryScoped();
      const keptFile = path.join(homeLayout(path, kept).workspace("bot_gone"), "files", "plan.md");
      yield* fs.makeDirectory(path.dirname(keptFile), { recursive: true });
      yield* fs.writeFileString(keptFile, "Kept when Bea was deleted.\n");
      const refused = yield* Effect.exit(importFrom(kept, file));
      assert.deepInclude(failedWith(refused), { _tag: "HomeInUse", bots: 0, files: true });
      assert.strictEqual(yield* fs.readFileString(keptFile), "Kept when Bea was deleted.\n");

      // A server that only started there installed its own skills, which are no one's to lose.
      const fresh = yield* fs.makeTempDirectoryScoped();
      for (const skill of sharedSkills) {
        const at = path.join(homeLayout(path, fresh).sharedSkills, skill.name, "SKILL.md");
        yield* fs.makeDirectory(path.dirname(at), { recursive: true });
        yield* fs.writeFileString(at, skill.text);
      }
      assert.strictEqual((yield* importFrom(fresh, file)).bots, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "moves a home that never saved a secret into one where nothing ran yet",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* fs.makeTempDirectoryScoped();
      const ana = yield* createBot("Ana").pipe(Effect.provide(serverAt(from)));
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      assert.deepStrictEqual((yield* exportTo(from, file)).secrets, { _tag: "none" });

      // No secrets folder here, and none in the archive.
      const to = yield* fs.makeTempDirectoryScoped();
      assert.strictEqual((yield* importFrom(to, file)).bots, 1);
      assert.isFalse(yield* fs.exists(importMark(path, to)));
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* workspaceOf(ana.id), homeLayout(path, to).workspace(ana.id));
      }).pipe(Effect.provide(serverAt(to)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect.skipIf(process.platform === "win32")(
  "refuses a home whose shared memory is a link of the operator's unless asked, and keeps the link",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      yield* exportTo(from.home, file);

      // Linked to a disk that is empty, or not mounted, right now.
      const elsewhere = yield* fs.makeTempDirectoryScoped();
      const to = yield* fs.makeTempDirectoryScoped();
      const memory = homeLayout(path, to).sharedMemory;
      yield* fs.makeDirectory(path.dirname(memory), { recursive: true });
      yield* fs.symlink(elsewhere, memory);
      const refused = yield* Effect.exit(importFrom(to, file));
      assert.deepInclude(failedWith(refused), { _tag: "HomeInUse", bots: 0, files: true });
      assert.strictEqual((yield* fs.lstat(memory)).type, "SymbolicLink");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect(
  "refuses an archive whose database keeps an attachment outside the attachments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const folder = yield* fs.makeTempDirectoryScoped();
      const file = path.join(folder, "export.tar.gz");
      yield* exportTo(from.home, file);
      const forged = path.join(folder, "forged.tar.gz");
      yield* forgeDatabase(
        file,
        forged,
        (sql) => sql`
          INSERT INTO blobs (sha256, size, storage_path, created_at)
          VALUES (${"0".repeat(64)}, 1, '../../config.json', '2026-11-01T00:00:00.000Z')
        `,
      );

      const to = yield* fs.makeTempDirectoryScoped();
      const refused = yield* Effect.exit(importFrom(to, forged));
      assert.deepInclude(failedWith(refused), { _tag: "ExportRefused", reason: "damaged" });
      assert.isFalse(yield* fs.exists(path.join(to, "j3.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);

it.effect.skipIf(process.platform === "win32")(
  "leaves out a file no import takes the name of, and never writes over a file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const from = yield* populatedHome;
      const odd = path.join(
        homeLayout(path, from.home).workspace(from.ana),
        "files",
        "C:\\report.txt",
      );
      yield* fs.makeDirectory(path.dirname(odd), { recursive: true });
      yield* fs.writeFileString(odd, "A Windows path as a name.\n");
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "export.tar.gz");
      const exported = yield* exportTo(from.home, file);
      assert.deepStrictEqual(exported.namesLeftOut, [`bots/${from.ana}/files/C:\\report.txt`]);
      const to = yield* fs.makeTempDirectoryScoped();
      assert.strictEqual((yield* importFrom(to, file)).bots, 1);

      const before = yield* fs.readFile(file);
      const again = yield* Effect.exit(exportTo(from.home, file));
      assert.strictEqual(failedWith(again)?._tag, "OutputExists");
      assert.deepStrictEqual(yield* fs.readFile(file), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: MOVE_TIMEOUT },
);
