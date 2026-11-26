// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { sharedSkills } from "@j3-bots/prompts";
import { compareVersions } from "@j3-bots/release";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import packageJson from "../../package.json" with { type: "json" };
import { flushFolder, replaceFileDurably } from "../files.ts";
import { takeForTransfer } from "../home/Home.ts";
import { HOME_ENTRIES, homeLayout } from "../home/entries.ts";
import { knownMigrations, runMigrations } from "../persistence/Migrations.ts";
import { newWebhookSecret } from "../routines/Routines.ts";
import { KEY_FILE, migrations as secretsMigrations } from "../secrets/store.ts";
import { importKey, importSecrets, secretsAtHome } from "../secrets/transfer.ts";
import { freeSpaceAt } from "../system/freeSpace.ts";
import {
  ARCHIVE_FORMAT,
  ARCHIVED_DATABASE,
  ARCHIVED_SECRETS,
  ARCHIVED_SHIPPED_SKILLS,
  type ArchivedSecrets,
  archivable,
  FormatJson,
  MANIFEST,
  MANIFEST_LIMIT,
  type Manifest,
  ManifestJson,
  plainName,
} from "./archive.ts";
import { importMark, importStaging } from "./importMark.ts";
import { readFirst, unpack } from "./tar.ts";

// `j3-bots import` (docs/architecture/server.md, "Moving to another server").
// The home is held (`takeForTransfer`) from the first read of the archive to
// the last file put in place, so no server starts on it meanwhile.
//
// 1. The manifest is read and checked: a format this release reads, nothing
//    a newer release wrote, every name one this system holds.
// 2. The archive is unpacked into `state/import/`, each file checked against
//    the manifest's size and SHA-256, and flushed to the disk with its folders.
// 3. The secrets are sealed again under this home's key, and the database is
//    checked, migrated and pointed at this home: each bot's workspace here,
//    no engine project, a new secret for each webhook, and its sessions in an
//    engine this home does not have, which the first start finds lost
//    (`turns/Observer.ts`).
// 4. With the mark written, naming the archive, each of the home's entries
//    the archive carries is put in place of what was there, and flushed. A
//    stop before the mark changes nothing the home held; a stop after it
//    leaves the mark, and the server refuses the home until the import of
//    that archive runs again, or another one is imported with `--replace`.

/** Free space an import keeps beyond the files it unpacks. */
const IMPORT_ROOM = 256 * 1024 * 1024;

/** Why an archive is not one this release imports. Never names a secret. */
class ExportRefused extends Schema.TaggedError<ExportRefused>()("ExportRefused", {
  file: Schema.String,
  reason: Schema.Literals(["not-an-export", "format", "newer", "damaged", "name"]),
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-an-export":
        return `${this.file} is not an export of J3 Bots (${this.detail}). Nothing was imported.`;
      case "format":
        return `${this.file} is an export in a format this release of J3 Bots does not read (${this.detail}). Update J3 Bots here, then import it. Nothing was imported.`;
      case "newer":
        return `${this.file} was exported by J3 Bots ${this.detail}, which changed the data in ways this release does not know. Update J3 Bots here to that release or later, then import it. Nothing was imported.`;
      case "damaged":
        return `${this.file} was changed or damaged after it was exported (${this.detail}). Nothing was imported.`;
      case "name":
        return `${this.file} holds a file this system cannot keep under its name (${this.detail}). Rename it on the server it came from and export again. Nothing was imported.`;
    }
  }
}

/**
 * The home already holds what the import would delete, and the import was
 * not asked to replace it: bots, secrets, or files of the bots', the shared
 * memory and skills, or the attachments (kept from a deleted bot, say).
 */
class HomeInUse extends Schema.TaggedError<HomeInUse>()("HomeInUse", {
  home: Schema.String,
  bots: Schema.Int,
  secrets: Schema.Boolean,
  files: Schema.Boolean,
}) {
  override get message(): string {
    const held = [
      ...(this.bots > 0 ? [`${this.bots} bot${this.bots === 1 ? "" : "s"}`] : []),
      ...(this.secrets ? ["secrets"] : []),
      ...(this.files ? ["files of bots, shared memory or skills, or attachments"] : []),
    ].join(", ");
    return `${this.home} already holds ${held}. Import with --replace to delete them and put the export's in their place. Nothing was imported.`;
  }
}

/** An import of another archive into the home began putting it in place and did not finish. */
class AnotherImportUnfinished extends Schema.TaggedError<AnotherImportUnfinished>()(
  "AnotherImportUnfinished",
  { home: Schema.String },
) {
  override get message(): string {
    return `An import of another export into ${this.home} stopped halfway. Run that import again to finish it, or import this one with --replace to put it in place instead. Nothing was imported.`;
  }
}

/** A folder the import writes and deletes in is a link, which would take it out of the home. */
class HomeLinked extends Schema.TaggedError<HomeLinked>()("HomeLinked", {
  folder: Schema.String,
}) {
  override get message(): string {
    return `${this.folder} is a link, and the import would write and delete through it, outside the data directory. Make it a folder of its own, then import. Nothing was imported.`;
  }
}

/** The disk the home is on has no room for the export unpacked. */
class NoRoomToImport extends Schema.TaggedError<NoRoomToImport>()("NoRoomToImport", {
  home: Schema.String,
  needed: Schema.Number,
  free: Schema.Number,
}) {
  override get message(): string {
    const mib = (bytes: number) => `${Math.ceil(bytes / 1024 ** 2)} MiB`;
    return `The import needs ${mib(this.needed)} free where ${this.home} is, and there are ${mib(this.free)}. Nothing was imported.`;
  }
}

/** What an import put in the home. */
interface Imported {
  readonly bots: number;
  readonly files: number;
  readonly secrets: ArchivedSecrets;
  /** The release that exported it. */
  readonly version: string;
  readonly exportedAt: DateTime.Utc;
  /** Whether the home held bots, secrets or their files, which are gone. */
  readonly replaced: boolean;
}

/** The passphrase, asked for at most this many times while it is wrong. */
export interface PassphraseAsk<E, R> {
  readonly ask: Effect.Effect<Redacted.Redacted<string>, E, R>;
  readonly attempts: number;
}

const openDatabase = (file: string) =>
  SqliteClient.make({ filename: file }).pipe(Effect.provide(Reactivity.layer));

const decodeFormat = Schema.decodeUnknownEffect(FormatJson);
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
const BotRow = Schema.Struct({ id: Schema.String });
const decodeBots = Schema.decodeUnknownEffect(Schema.Array(BotRow));
const BlobRow = Schema.Struct({ sha256: Schema.String, storage_path: Schema.String });
const decodeBlobs = Schema.decodeUnknownEffect(Schema.Array(BlobRow));
const IdRow = Schema.Struct({ id: Schema.String });
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow));

/**
 * What the mark says: the archive being put in place, by its manifest's
 * SHA-256, which names the SHA-256 of every file after it.
 */
const MarkJson = Schema.fromJsonString(Schema.Struct({ archive: Schema.String }));
const decodeMark = Schema.decodeUnknownOption(MarkJson);
const encodeMark = Schema.encodeEffect(MarkJson);

/** Systems whose file names ignore case, where two names that differ only in it are one file. */
const CASE_BLIND = new Set(["win32", "darwin"]);

/** The manifest of the archive at `file`, checked against what this release reads. */
const readManifest = Effect.fn("transfer.readManifest")(function* (file: string) {
  const refused = (reason: ExportRefused["reason"], detail: string) =>
    new ExportRefused({ file, reason, detail });
  const first = yield* readFirst(file, MANIFEST, MANIFEST_LIMIT).pipe(
    Effect.mapError((error) => refused("not-an-export", error.detail)),
  );
  const text = (first.bytes ?? Buffer.alloc(0)).toString("utf8");
  const { format } = yield* decodeFormat(text).pipe(
    Effect.mapError(() => refused("not-an-export", "its manifest does not read")),
  );
  if (format !== ARCHIVE_FORMAT) return yield* refused("format", format);
  const manifest = yield* decodeManifest(text).pipe(
    Effect.mapError(() => refused("damaged", "its manifest does not read")),
  );
  const newest = Math.max(...(yield* knownMigrations));
  const newestSecrets = Math.max(...(yield* secretsMigrations).map(([id]) => id));
  const newerRelease = Option.contains(compareVersions(manifest.version, packageJson.version), 1);
  if (
    newerRelease ||
    manifest.lastMigration > newest ||
    (manifest.secrets._tag === "sealed" && manifest.secrets.lastMigration > newestSecrets)
  ) {
    return yield* refused("newer", manifest.version);
  }
  const names = new Set<string>();
  const folded = new Set<string>();
  const caseBlind = CASE_BLIND.has(process.platform);
  for (const { path } of manifest.files) {
    if (names.has(path)) return yield* refused("damaged", `${path} is listed twice`);
    names.add(path);
    if (!archivable(path, "posix")) return yield* refused("damaged", `it lists ${path}`);
    if (!archivable(path)) return yield* refused("name", path);
    const key = path.toLowerCase();
    if (caseBlind && folded.has(key)) {
      return yield* refused("name", `${path}, which differs from another only in case`);
    }
    folded.add(key);
  }
  if (!names.has(ARCHIVED_DATABASE)) {
    return yield* refused("damaged", `it holds no ${ARCHIVED_DATABASE}`);
  }
  if ((manifest.secrets._tag === "sealed") !== names.has(ARCHIVED_SECRETS)) {
    return yield* refused("damaged", "its secrets are not as the manifest says");
  }
  return { manifest, identity: first.sha256 };
});

/**
 * Unpacks the archive at `file` into `staging`: each file the manifest lists,
 * in its order, with its size and SHA-256, and nothing else.
 */
const unpackInto = Effect.fn("transfer.unpackInto")(function* (
  file: string,
  manifest: Manifest,
  staging: string,
) {
  const path = yield* Path.Path;
  const unpacked = yield* unpack(file, (entry, before) => {
    if (before.length === 0) {
      return entry.name === MANIFEST
        ? { _tag: "memory", limit: MANIFEST_LIMIT }
        : `its first file is not ${MANIFEST}`;
    }
    const listed = manifest.files[before.length - 1];
    if (listed === undefined) return `${entry.name} is not in its manifest`;
    if (listed.path !== entry.name || listed.size !== entry.size) {
      return `${entry.name} is not the file its manifest lists there`;
    }
    return { _tag: "file", path: path.join(staging, ...entry.name.split("/")) };
  }).pipe(
    Effect.mapError(
      (error) => new ExportRefused({ file, reason: "damaged", detail: error.detail }),
    ),
  );
  const files = unpacked.slice(1);
  if (files.length !== manifest.files.length) {
    return yield* new ExportRefused({ file, reason: "damaged", detail: "files are missing" });
  }
  for (const [index, { name, sha256 }] of files.entries()) {
    if (manifest.files[index]?.sha256 !== sha256) {
      return yield* new ExportRefused({
        file,
        reason: "damaged",
        detail: `${name} is not the file that was exported`,
      });
    }
  }
  // Each file was flushed as it was written; the names of the folders made for them now are.
  yield* flushFolders(staging);
});

/** Flushes every folder under `root`, the deepest first, then `root` and the folder it is in. */
const flushFolders = Effect.fn("transfer.flushFolders")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders: Array<string> = [];
  for (const relative of yield* fs.readDirectory(root, { recursive: true })) {
    const each = path.join(root, relative);
    if ((yield* fs.lstat(each)).type === "Directory") folders.push(each);
  }
  folders.sort((a, b) => b.length - a.length);
  for (const folder of [...folders, root, path.dirname(root)]) yield* flushFolder(folder);
});

/** How many bots the database at `file` holds; none when there is none. */
const botsIn = Effect.fn("transfer.botsIn")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return 0;
  const sql = yield* openDatabase(file);
  const [table] = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bots'`;
  if (table === undefined) return 0;
  const [counted] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM bots`;
  return counted?.n ?? 0;
}, Effect.scoped);

/** The place an attachment's bytes are kept, named by its SHA-256 (`attachments/Attachments.ts`). */
const isBlobPath = (sha256: string, storagePath: string) =>
  /^[0-9a-f]{64}$/.test(sha256) && storagePath === `${sha256.slice(0, 2)}/${sha256}`;

/**
 * The export's database at `file`, checked, migrated to this release and
 * pointed at `home`: each bot's workspace there, found again when it is
 * provisioned, no engine project, a new secret for each webhook, every
 * session in an engine this home does not have, and no paired device. A bot
 * whose id is no folder's name, or an attachment kept anywhere but under its
 * digest, refuses the archive: each becomes a path in the home.
 */
const readyDatabase = Effect.fn("transfer.readyDatabase")(
  function* (file: string, home: string, archive: string) {
    const path = yield* Path.Path;
    const sql = yield* openDatabase(file);
    const damaged = (detail: string) =>
      new ExportRefused({ file: archive, reason: "damaged", detail });
    yield* runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const bots = yield* decodeBots(yield* sql`SELECT id FROM bots`).pipe(Effect.orDie);
    if (!bots.every(({ id }) => plainName(id))) {
      return yield* damaged("its database names a bot no folder can be named after");
    }
    const blobs = yield* decodeBlobs(yield* sql`SELECT sha256, storage_path FROM blobs`).pipe(
      Effect.orDie,
    );
    if (!blobs.every(({ sha256, storage_path }) => isBlobPath(sha256, storage_path))) {
      return yield* damaged("its database keeps an attachment outside the attachments");
    }
    const layout = homeLayout(path, home);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const { id } of bots) {
          yield* sql`
          UPDATE bots
          SET workspace_path = ${layout.workspace(id)}, workspace_root = NULL, engine_project_id = NULL
          WHERE id = ${id}
        `;
        }
        // An export carries no webhook secret, which is a webhook's credential.
        const hooks = yield* decodeIds(
          yield* sql`
          SELECT id FROM routines
          WHERE webhook_secret IS NULL AND json_extract(trigger_json, '$._tag') = 'webhook'
        `,
        ).pipe(Effect.orDie);
        for (const { id } of hooks) {
          yield* sql`UPDATE routines SET webhook_secret = ${yield* newWebhookSecret} WHERE id = ${id}`;
        }
        // A device paired with the server the export came from is not paired with this one.
        yield* sql`DELETE FROM devices`;
        yield* sql`
        INSERT INTO engine_instance (id, instance_id, recorded_at) VALUES (1, NULL, ${now})
        ON CONFLICT (id) DO UPDATE SET instance_id = NULL, recorded_at = excluded.recorded_at
      `;
      }),
    );
    // One file, no log beside it, to be moved into place.
    yield* sql`PRAGMA journal_mode = DELETE`;
    return bots.length;
  },
  Effect.scoped,
  Effect.provide(SecureRandom.layerWebCrypto),
);

/**
 * The home's entries an import puts in place, relative to the home, each
 * with SQLite's files beside it that go with it. What the import does not
 * bring of them is removed, but for the secrets' key, which stays.
 */
const PUT_IN_PLACE: ReadonlyArray<{
  readonly entry: string;
  readonly beside: ReadonlyArray<string>;
  readonly keptWhenNotBrought: boolean;
}> = [
  {
    entry: ARCHIVED_DATABASE,
    beside: [HOME_ENTRIES.databaseLog, HOME_ENTRIES.databaseLogIndex],
    keptWhenNotBrought: false,
  },
  {
    entry: ARCHIVED_SECRETS,
    beside: [`${ARCHIVED_SECRETS}-wal`, `${ARCHIVED_SECRETS}-shm`],
    keptWhenNotBrought: false,
  },
  { entry: `${HOME_ENTRIES.secrets}/${KEY_FILE}`, beside: [], keptWhenNotBrought: true },
  { entry: ARCHIVED_SHIPPED_SKILLS, beside: [], keptWhenNotBrought: false },
  { entry: HOME_ENTRIES.bots, beside: [], keptWhenNotBrought: false },
  { entry: `${HOME_ENTRIES.shared}/memory`, beside: [], keptWhenNotBrought: false },
  { entry: `${HOME_ENTRIES.shared}/skills`, beside: [], keptWhenNotBrought: false },
  { entry: HOME_ENTRIES.attachments, beside: [], keptWhenNotBrought: false },
];

/** The folders, relative to the home, an import writes and deletes in, besides the home itself. */
const IMPORT_FOLDERS = [HOME_ENTRIES.state, HOME_ENTRIES.secrets, HOME_ENTRIES.shared];

/** Fails when a folder the import works in is a link, which would take its writes and deletes elsewhere. */
const checkFolders = Effect.fn("transfer.checkFolders")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const folder of IMPORT_FOLDERS) {
    const at = path.join(home, folder);
    const info = yield* fs.lstat(at).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type !== "Directory") {
      return yield* new HomeLinked({ folder: at });
    }
  }
});

/**
 * Puts what `staging` holds in place of the home's entries, as `PUT_IN_PLACE`
 * lists them, then flushes every folder it changed, the home's last: the
 * mark is removed only once the names it moved and removed are on the disk.
 * (On Windows NTFS writes them to its journal in order, before the mark's
 * removal: `flushFolder`.)
 */
const putInPlace = Effect.fn("transfer.putInPlace")(function* (home: string, staging: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = (root: string, relative: string) => path.join(root, ...relative.split("/"));
  const present = (file: string) => Effect.map(fs.lstat(file).pipe(Effect.option), Option.isSome);
  // Only folders that hold a name that changed: one the import neither found nor made does not exist.
  const changed = new Set<string>();
  for (const { entry, beside, keptWhenNotBrought } of PUT_IN_PLACE) {
    const target = at(home, entry);
    const staged = at(staging, entry);
    const brought = yield* fs.exists(staged);
    if (!brought && keptWhenNotBrought) continue;
    for (const old of [...beside.map((name) => at(home, name)), target]) {
      if (!(yield* present(old))) continue;
      yield* fs.remove(old, { recursive: true, force: true });
      changed.add(path.dirname(old));
    }
    if (!brought) continue;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    yield* fs.rename(staged, target);
    changed.add(path.dirname(target));
  }
  changed.delete(home);
  for (const folder of [...changed, home]) yield* flushFolder(folder);
});

/**
 * Whether `root` is a link or a file where the server keeps a folder: the
 * operator's own arrangement, which an import replaces only when asked.
 */
const notOwnFolder = Effect.fn("transfer.notOwnFolder")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.lstat(root).pipe(Effect.option);
  return Option.isSome(info) && info.value.type !== "Directory";
});

/** Whether `root` holds anything but folders, or is not a folder itself; nothing when it is missing. */
const holdsFiles = Effect.fn("transfer.holdsFiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* notOwnFolder(root)) return true;
  if (!(yield* fs.exists(root))) return false;
  for (const relative of yield* fs.readDirectory(root, { recursive: true })) {
    if ((yield* fs.lstat(path.join(root, relative))).type !== "Directory") return true;
  }
  return false;
});

/**
 * Whether the shared skills hold anything but the server's own copies of the
 * skills it ships, as this release ships them: anything else is the
 * operator's, and an import replaces it only when asked.
 */
const holdsOwnSkills = Effect.fn("transfer.holdsOwnSkills")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* notOwnFolder(root)) return true;
  if (!(yield* fs.exists(root))) return false;
  for (const name of yield* fs.readDirectory(root)) {
    const shipped = sharedSkills.find((skill) => skill.name === name);
    if (shipped === undefined) return true;
    const folder = path.join(root, name);
    if ((yield* fs.lstat(folder)).type !== "Directory") return true;
    const inside = yield* fs.readDirectory(folder, { recursive: true });
    const skillFile = path.join(folder, "SKILL.md");
    if (inside.length !== 1 || inside[0] !== "SKILL.md") return true;
    if ((yield* fs.lstat(skillFile)).type !== "File") return true;
    if ((yield* fs.readFileString(skillFile)) !== shipped.text) return true;
  }
  return false;
});

/** Whether the home holds files an import would delete that the server did not make on its own. */
const homeHoldsFiles = Effect.fn("transfer.homeHoldsFiles")(function* (home: string) {
  const path = yield* Path.Path;
  for (const folder of [
    HOME_ENTRIES.bots,
    `${HOME_ENTRIES.shared}/memory`,
    HOME_ENTRIES.attachments,
  ]) {
    if (yield* holdsFiles(path.join(home, ...folder.split("/")))) return true;
  }
  return yield* holdsOwnSkills(path.join(home, HOME_ENTRIES.shared, "skills"));
});

/**
 * Imports the export at `file` into `home`. A home that holds bots, secrets
 * or their files is refused unless `replace`, and then holds only the export's.
 * The passphrase is asked for only when the export holds sealed secrets.
 * The home's configuration, its engine and provider sign-ins stay as they
 * are; no paired device does.
 */
export const importHome = Effect.fn("transfer.importHome")(function* <E, R>(input: {
  readonly home: string;
  readonly file: string;
  readonly replace: boolean;
  readonly passphrase: PassphraseAsk<E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home, file } = input;
  yield* takeForTransfer(home, "import");
  yield* checkFolders(home);
  const { manifest, identity } = yield* readManifest(file);

  const mark = importMark(path, home);
  // An import that stopped while it put this export in place left the home
  // part one, part the other: this one puts it in place whole. One of another
  // export is replaced only when asked.
  const marked = yield* fs.readFileString(mark).pipe(Effect.option);
  const finishing = Option.isSome(marked);
  const sameArchive = Option.exists(
    Option.flatMap(marked, decodeMark),
    ({ archive }) => archive === identity,
  );
  if (finishing && !sameArchive && !input.replace) {
    return yield* new AnotherImportUnfinished({ home });
  }
  const vault = path.join(home, HOME_ENTRIES.secrets);
  const bots = yield* botsIn(path.join(home, HOME_ENTRIES.database));
  const secrets = (yield* secretsAtHome(vault))._tag !== "none";
  const files = yield* homeHoldsFiles(home);
  if ((bots > 0 || secrets || files) && !input.replace && !finishing) {
    return yield* new HomeInUse({ home, bots, secrets, files });
  }

  const staging = importStaging(path, home);
  yield* fs.remove(staging, { recursive: true, force: true });
  const needed = manifest.files.reduce((total, { size }) => total + size, 0) + IMPORT_ROOM;
  const free = yield* freeSpaceAt(home);
  if (Option.isSome(free) && free.value < needed) {
    return yield* new NoRoomToImport({ home, needed, free: free.value });
  }

  const imported = yield* Effect.gen(function* () {
    yield* unpackInto(file, manifest, staging);
    if (manifest.secrets._tag === "sealed") {
      const { kdf } = manifest.secrets;
      const copy = path.join(staging, ...ARCHIVED_SECRETS.split("/"));
      const key = yield* importKey(vault, path.join(staging, HOME_ENTRIES.secrets, KEY_FILE));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          for (let attempt = 1; ; attempt++) {
            const typed = yield* input.passphrase.ask;
            const opened = yield* Effect.result(importSecrets(copy, kdf, typed, key));
            if (Result.isSuccess(opened)) return;
            if (opened.failure._tag !== "WrongPassphrase" || attempt >= input.passphrase.attempts) {
              return yield* opened.failure;
            }
            yield* Effect.logInfo("That passphrase does not open the export's secrets");
          }
        }),
        Effect.sync(() => key.fill(0)),
      );
    }
    const count = yield* readyDatabase(path.join(staging, ARCHIVED_DATABASE), home, file);

    yield* replaceFileDurably(mark, yield* encodeMark({ archive: identity }), 0o600);
    yield* putInPlace(home, staging);
    yield* fs.remove(mark);
    yield* flushFolder(path.dirname(mark));
    return count;
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );

  return {
    bots: imported,
    files: manifest.files.length,
    secrets: manifest.secrets,
    version: manifest.version,
    exportedAt: manifest.createdAt,
    replaced: bots > 0 || secrets || files || finishing,
  } satisfies Imported;
}, Effect.scoped);
