// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, NonNegativeInt } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { HOME_ENTRIES, WORKSPACE_ENTRIES } from "../home/entries.ts";

// What `j3-bots export` writes and `j3-bots import` reads
// (docs/architecture/server.md, "Moving to another server"): a gzipped tar
// (`tar.ts`) whose first file is `manifest.json`, then the files it lists,
// each by its path relative to the home, `/` between its parts:
//
//   manifest.json                    Manifest
//   j3.sqlite                        a copy of the database, paired devices left out
//   vault/vault.sqlite               the secrets, sealed under the export's passphrase
//   state/shipped-skills.json
//   bots/<bot>/{memory,skills,files}/...
//   shared/{memory,skills}/...
//   attachments/...
//
// Nothing else: not `config.json`, not the engine's folder, its database,
// credential and provider key, not the providers' homes and their sign-ins,
// not the update snapshots, not the secrets' key file.

/** The archive's format, which an import reads only if it knows it. */
export const ARCHIVE_FORMAT = "j3-bots-export-1";

/** The first file of the archive. */
export const MANIFEST = "manifest.json";

/** The most bytes the manifest may take: a few hundred per file it lists. */
export const MANIFEST_LIMIT = 64 * 1024 * 1024;

/** The archive's copy of the database. */
export const ARCHIVED_DATABASE = HOME_ENTRIES.database;

/** The archive's copy of the secrets, sealed under the export's passphrase. */
export const ARCHIVED_SECRETS = `${HOME_ENTRIES.secrets}/vault.sqlite`;

/** Which texts of the shared skills the server installed. */
export const ARCHIVED_SHIPPED_SKILLS = `${HOME_ENTRIES.state}/shipped-skills.json`;

/** A bot's folders the archive carries: what it remembers and what is its own. */
export const BOT_FOLDERS = [
  WORKSPACE_ENTRIES.memory,
  WORKSPACE_ENTRIES.skills,
  WORKSPACE_ENTRIES.files,
] as const;

/** The shared folders the archive carries. */
export const SHARED_FOLDERS = ["memory", "skills"] as const;

/** How the export's passphrase became the key its secrets are sealed under. */
const ExportKdf = Schema.Struct({
  algorithm: Schema.Literal("scrypt"),
  n: Schema.Int,
  r: Schema.Int,
  p: Schema.Int,
  /** base64. */
  salt: Schema.String,
});

/** What the archive holds of the secrets. */
export const ArchivedSecrets = Schema.Union([
  /** None: nothing was ever saved. */
  Schema.TaggedStruct("none", {}),
  /** Left out, since they could not be read: a key file missing or holding another key, or a newer release's. */
  Schema.TaggedStruct("left-out", {
    reason: Schema.Literals(["unreadable", "newer"]),
  }),
  /** In `vault/vault.sqlite`, every value sealed under the key `kdf` derives from the passphrase. */
  Schema.TaggedStruct("sealed", {
    /** How many secrets and connector secrets. */
    records: NonNegativeInt,
    /** The secrets' last migration. */
    lastMigration: NonNegativeInt,
    kdf: ExportKdf,
  }),
]);
export type ArchivedSecrets = typeof ArchivedSecrets.Type;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const ArchivedFile = Schema.Struct({
  path: Schema.String,
  size: NonNegativeInt,
  sha256: Sha256,
});
export type ArchivedFile = typeof ArchivedFile.Type;

export const Manifest = Schema.Struct({
  format: Schema.Literal(ARCHIVE_FORMAT),
  /** The release of J3 Bots that wrote it. */
  version: Schema.String,
  /** The protocol that release spoke. */
  protocolVersion: NonNegativeInt,
  /** The database's last migration. */
  lastMigration: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  /** How many bots it holds. */
  bots: NonNegativeInt,
  secrets: ArchivedSecrets,
  /** Every file after the manifest, in the archive's order. */
  files: Schema.Array(ArchivedFile),
});
export type Manifest = typeof Manifest.Type;

export const ManifestJson = Schema.fromJsonString(Schema.toCodecJson(Manifest));

/** Only the format, read first: a manifest of a format this release does not know is not decoded. */
export const FormatJson = Schema.fromJsonString(Schema.Struct({ format: Schema.String }));

const isBotId = Schema.is(BotId);

/** Characters and names Windows does not take in a file's name. */
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_DEVICES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Whether `part` is one plain name in a path: not empty, not `.` or `..`,
 * no `/`, `\` or NUL in it; on Windows, one the system takes as it is.
 */
export const plainName = (part: string, platform: string = process.platform): boolean =>
  part !== "" &&
  part !== "." &&
  part !== ".." &&
  !part.includes("/") &&
  !part.includes("\\") &&
  !part.includes("\0") &&
  (platform !== "win32" ||
    (!WINDOWS_FORBIDDEN.test(part) && !WINDOWS_DEVICES.test(part) && !/[. ]$/.test(part)));

/**
 * Whether `name` is a file the archive may hold: one of its own files, or a
 * file inside a bot's memory, skills or files, the shared memory and skills,
 * or the attachments. Every part is a plain name (`plainName`).
 */
export const archivable = (name: string, platform: string = process.platform): boolean => {
  const parts = name.split("/");
  if (!parts.every((part) => plainName(part, platform))) return false;
  if ([ARCHIVED_DATABASE, ARCHIVED_SECRETS, ARCHIVED_SHIPPED_SKILLS].includes(name)) return true;
  const [root, second, third] = parts;
  switch (root) {
    case HOME_ENTRIES.bots:
      return (
        parts.length > 3 &&
        second !== undefined &&
        isBotId(second) &&
        BOT_FOLDERS.some((folder) => folder === third)
      );
    case HOME_ENTRIES.shared:
      return parts.length > 2 && SHARED_FOLDERS.some((folder) => folder === second);
    case HOME_ENTRIES.attachments:
      return parts.length > 1;
    default:
      return false;
  }
};
