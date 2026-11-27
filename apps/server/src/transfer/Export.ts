// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { PROTOCOL_VERSION } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Reactivity from "effect/reactivity/Reactivity";
import packageJson from "../../package.json" with { type: "json" };
import { takeForTransfer } from "../home/Home.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { createPrivateFolder } from "../home/windowsAcl.ts";
import { isWithin, realLocation } from "../paths.ts";
import { knownMigrations } from "../persistence/Migrations.ts";
import { exportSecrets } from "../secrets/transfer.ts";
import {
  ARCHIVE_FORMAT,
  ARCHIVED_DATABASE,
  ARCHIVED_SECRETS,
  ARCHIVED_SHIPPED_SKILLS,
  type ArchivedFile,
  type WrittenSecrets,
  archivable,
  BOT_FOLDERS,
  MANIFEST,
  type Manifest,
  ManifestJson,
  SHARED_FOLDERS,
} from "./archive.ts";
import { type DiskEntry, measureFile, writeTarGz } from "./tar.ts";

// `j3-bots export` (docs/architecture/server.md, "Moving to another server").
// The home is held (`takeForTransfer`) while its files are copied, measured
// and written, so no server changes them meanwhile.

/** The database records a migration this release does not know: a newer release wrote it. */
class DatabaseNewer extends Schema.TaggedError<DatabaseNewer>()("DatabaseNewer", {
  migration: Schema.Int,
}) {
  override get message(): string {
    return `The database records migration ${this.migration}, which this release of J3 Bots does not know: a newer release wrote it. Export with that release.`;
  }
}

/** Something is already where the export would go. */
class OutputExists extends Schema.TaggedError<OutputExists>()("OutputExists", {
  file: Schema.String,
}) {
  override get message(): string {
    return `${this.file} already exists. Name another file with --output, or move that one away.`;
  }
}

/** The home has no database: nothing ran there. */
class NothingToExport extends Schema.TaggedError<NothingToExport>()("NothingToExport", {
  home: Schema.String,
}) {
  override get message(): string {
    return `${this.home} holds no J3 Bots database, so there is nothing to export.`;
  }
}

/** What an export wrote. */
interface Exported {
  readonly file: string;
  readonly bots: number;
  readonly secrets: WrittenSecrets;
  readonly files: number;
  readonly bytes: number;
  /** Links in the bots' own folders and the shared ones, which the archive does not carry. */
  readonly linksLeftOut: number;
  /** Files left out under a name no import takes, as the archive would name them. */
  readonly namesLeftOut: ReadonlyArray<string>;
  /** Attachments the database names whose bytes are missing. */
  readonly attachmentsMissing: number;
}

const openDatabase = (file: string) =>
  SqliteClient.make({ filename: file }).pipe(Effect.provide(Reactivity.layer));

const BotRow = Schema.Struct({ id: Schema.String });
const BlobRow = Schema.Struct({ storage_path: Schema.String });
const decodeBots = Schema.decodeUnknownEffect(Schema.Array(BotRow));
const decodeBlobs = Schema.decodeUnknownEffect(Schema.Array(BlobRow));

/**
 * The database at `source` copied to `destination` as it stands, with no
 * paired device, push registration or delivery in the copy: every device
 * pairs with the server the home moves to. No command receipt either: they
 * answer a device's retry on this server, and one of a webhook routine holds
 * its address, secret included.
 */
const copyDatabase = Effect.fn("transfer.copyDatabase")(function* (
  source: string,
  destination: string,
) {
  const sql = yield* openDatabase(source);
  const known = new Set(yield* knownMigrations);
  const recorded = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
  `;
  const unknown = recorded.find(({ migration_id }) => !known.has(migration_id));
  if (unknown !== undefined) return yield* new DatabaseNewer({ migration: unknown.migration_id });
  yield* sql`VACUUM INTO ${destination}`;
  const copy = yield* openDatabase(destination);
  yield* copy`PRAGMA journal_mode = MEMORY`;
  yield* copy.withTransaction(
    Effect.all([
      copy`DELETE FROM push_deliveries`,
      copy`DELETE FROM push_registrations`,
      copy`DELETE FROM devices`,
      copy`DELETE FROM command_receipts`,
      // A webhook's secret is its credential: none travels, and the import gives each a new one.
      copy`UPDATE routines SET webhook_secret = NULL`,
    ]),
  );
  // What was deleted leaves no page behind.
  yield* copy`VACUUM`;
  return {
    bots: (yield* decodeBots(yield* copy`SELECT id FROM bots ORDER BY rowid`)).map(({ id }) => id),
    blobs: (yield* decodeBlobs(yield* copy`SELECT storage_path FROM blobs ORDER BY rowid`)).map(
      ({ storage_path }) => storage_path,
    ),
    lastMigration: Math.max(0, ...recorded.map(({ migration_id }) => migration_id)),
  };
});

/**
 * The regular files under `root`, as `archived` names them, read where they
 * really are: none of `root` when it is a link or leads out of `realHome`,
 * and no link inside it, which is counted. A file under a name no import
 * takes (a `\` in it) is left out, and named.
 */
const filesUnder = Effect.fn("transfer.filesUnder")(function* (
  root: string,
  archived: string,
  realHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(root).pipe(Effect.option);
  if (Option.isNone(info)) return { files: [], links: 0, unnamed: [] };
  if (info.value.type !== "Directory") return { files: [], links: 1, unnamed: [] };
  const real = yield* realLocation(root);
  if (Option.isNone(real) || !isWithin(realHome, real.value)) {
    return { files: [], links: 1, unnamed: [] };
  }
  const files: Array<{ readonly name: string; readonly source: string }> = [];
  const unnamed: Array<string> = [];
  let links = 0;
  for (const relative of (yield* fs.readDirectory(root, { recursive: true })).toSorted()) {
    const source = path.join(root, relative);
    const each = yield* fs.lstat(source);
    if (each.type === "SymbolicLink") {
      links++;
      continue;
    }
    if (each.type !== "File") continue;
    // Read where it is, inside the folder: nothing leads it elsewhere.
    const where = yield* realLocation(source);
    if (Option.isNone(where) || !isWithin(real.value, where.value)) {
      links++;
      continue;
    }
    const name = `${archived}/${relative.split(path.sep).join("/")}`;
    // A name Windows alone cannot hold is the import's to refuse there, with the file named.
    if (archivable(name, "posix")) files.push({ name, source });
    else unnamed.push(name);
  }
  return { files, links, unnamed };
});

/**
 * A folder beside `file`, private to this user from its first moment, as
 * the archive must be until it is whole: on Windows the folder's own access
 * list, which the files made in it take and keep as they are renamed out
 * of it; elsewhere mode 0700. Gone with the scope.
 */
const privateFolderBeside = Effect.fn("transfer.privateFolderBeside")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(file);
  if (process.platform !== "win32") {
    return yield* fs.makeTempDirectoryScoped({ directory, prefix: ".j3-export-" });
  }
  const random = yield* SecureRandom.SecureRandom;
  const folder = path.join(directory, `.j3-export-${Hex.encode(yield* random.randomBytes(12))}`);
  yield* Effect.acquireRelease(createPrivateFolder(folder), () =>
    fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  return folder;
}, Effect.provide(SecureRandom.layerWebCrypto));

/**
 * Takes `file`'s name for this export, as an empty file only this call
 * made: of two exports to one name, the second is refused before it asks
 * anything. Removed again unless the export took its place.
 */
const claimOutput = Effect.fn("transfer.claimOutput")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.acquireRelease(
    fs.writeFile(file, new Uint8Array(0), { flag: "wx", mode: 0o600 }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.fail(new OutputExists({ file })),
      ),
    ),
    (_, exit) =>
      Exit.isSuccess(exit) ? Effect.void : fs.remove(file, { force: true }).pipe(Effect.ignore),
  );
});

/**
 * Writes the export of `home` to `file`, a file that must not exist yet,
 * private to this user. `passphrase` is asked for only when there are
 * secrets to seal, with how many. Nothing is left at `file` when it fails.
 */
export const exportHome = Effect.fn("transfer.exportHome")(function* <E, R>(input: {
  readonly home: string;
  readonly file: string;
  readonly passphrase: (records: number) => Effect.Effect<Redacted.Redacted<string>, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home, file } = input;
  const database = path.join(home, HOME_ENTRIES.database);
  if (!(yield* fs.exists(database))) return yield* new NothingToExport({ home });
  yield* takeForTransfer(home, "export");
  yield* claimOutput(file);
  const realHome = Option.getOrElse(yield* realLocation(home), () => path.resolve(home));

  // Private to this user, as `mkdtemp` makes it, and gone with the scope.
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "j3-bots-export-" });
  const copied = yield* copyDatabase(database, path.join(staging, "j3.sqlite"));
  const sealedSecrets = path.join(staging, "vault.sqlite");
  const secrets: WrittenSecrets = yield* exportSecrets(
    path.join(home, HOME_ENTRIES.secrets),
    sealedSecrets,
    input.passphrase,
  );

  const sources: Array<{ readonly name: string; readonly source: string }> = [
    { name: ARCHIVED_DATABASE, source: path.join(staging, "j3.sqlite") },
  ];
  if (secrets._tag === "sealed") sources.push({ name: ARCHIVED_SECRETS, source: sealedSecrets });
  const shipped = path.join(home, ...ARCHIVED_SHIPPED_SKILLS.split("/"));
  if (yield* fs.exists(shipped)) sources.push({ name: ARCHIVED_SHIPPED_SKILLS, source: shipped });
  let linksLeftOut = 0;
  const namesLeftOut: Array<string> = [];
  const trees = [
    ...copied.bots.flatMap((bot) =>
      BOT_FOLDERS.map((folder) => `${HOME_ENTRIES.bots}/${bot}/${folder}`),
    ),
    ...SHARED_FOLDERS.map((folder) => `${HOME_ENTRIES.shared}/${folder}`),
  ];
  for (const tree of trees) {
    const found = yield* filesUnder(path.join(home, ...tree.split("/")), tree, realHome);
    sources.push(...found.files);
    linksLeftOut += found.links;
    namesLeftOut.push(...found.unnamed);
  }
  let attachmentsMissing = 0;
  const attachments = path.join(home, HOME_ENTRIES.attachments);
  for (const stored of copied.blobs) {
    const name = `${HOME_ENTRIES.attachments}/${stored}`;
    const source = path.join(attachments, ...stored.split("/"));
    const info = yield* fs.lstat(source).pipe(Effect.option);
    if (!archivable(name, "posix") || Option.isNone(info) || info.value.type !== "File") {
      attachmentsMissing++;
      continue;
    }
    sources.push({ name, source });
  }

  const entries: Array<DiskEntry> = [];
  for (const { name, source } of sources) {
    entries.push({ _tag: "disk", name, source, ...(yield* measureFile(source)) });
  }
  const files: ReadonlyArray<ArchivedFile> = entries.map(({ name, size, sha256 }) => ({
    path: name,
    size,
    sha256,
  }));
  const now = yield* DateTime.now;
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    version: packageJson.version,
    protocolVersion: PROTOCOL_VERSION,
    lastMigration: copied.lastMigration,
    createdAt: now,
    bots: copied.bots.length,
    secrets,
    files,
  };
  const manifestText = yield* Schema.encodeEffect(ManifestJson)(manifest);

  // Written in a private folder beside its place and renamed over the claim,
  // so `file` is never half an archive, nor one others may open.
  const writing = path.join(yield* privateFolderBeside(file), "export.tar.gz");
  yield* writeTarGz(
    writing,
    [{ _tag: "bytes", name: MANIFEST, bytes: new TextEncoder().encode(manifestText) }, ...entries],
    DateTime.toDateUtc(now),
  );
  yield* fs.rename(writing, file);
  return {
    file,
    bots: copied.bots.length,
    secrets,
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
    linksLeftOut,
    namesLeftOut,
    attachmentsMissing,
  } satisfies Exported;
}, Effect.scoped);
