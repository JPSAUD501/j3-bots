// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Client, ProtocolError } from "@modelcontextprotocol/client";
import {
  DIRECTORY_MIME_TYPE,
  SKILL_LIMITS,
  SKILLS_EXTENSION_ID,
  type Skill,
  SkillsClient,
  SkillVerificationError,
} from "@modelcontextprotocol/client/ext/skills";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { cleanDescription, cleanText } from "./catalog.ts";
import type { ConnectorFailure } from "./errors.ts";
import { codePointsEnd } from "./text.ts";

/**
 * MCP's Skills extension (`io.modelcontextprotocol/skills`, SEP-2640): a
 * server serves Agent Skills, each a `SKILL.md` and the files beside it, as
 * resources, with `skills/list` and `skills/get` giving each skill's entry:
 * its frontmatter and a manifest of its files with their sizes and SHA-256
 * digests.
 *
 * The SDK J3 Bots pins has the client side (`SkillsClient`): it lists and
 * gets entries, and reads a file only when the entry lists it, checking its
 * size, its digest and, for `SKILL.md`, its frontmatter field by field, and
 * fetching once more a copy from the response cache that fails a check.
 * Here those requests are made as a session's others are (a deadline, a byte
 * budget, the connector's secrets taken out of what comes back), and what
 * they give is put in J3 Bots' terms. Which skills a bot sees, and what it
 * holds while it acts on one, is the server's (decision 0089).
 */

export const SKILLS_EXTENSION = SKILLS_EXTENSION_ID;

/** The most files and bytes a skill may have for J3 Bots to load it: the extension's own limits. */
export const MAX_SKILL_FILES = SKILL_LIMITS.files;
export const MAX_SKILL_BYTES = SKILL_LIMITS.bytes;

/** The longest skill address kept, in characters. */
const MAX_SKILL_URI = 2_048;

/**
 * The most one read of a skill's file may take, in bytes, as it arrives:
 * twice the largest skill, so a file the extension allows fits however its
 * server encodes it (base64, escaped text).
 */
const MAX_SKILL_READ_BYTES = 2 * MAX_SKILL_BYTES;

/** A skill a connector's server serves, as J3 Bots keeps it. */
export interface ServedSkill {
  /** Its `SKILL.md`'s address at its server: with the connector, what the skill is. */
  readonly uri: string;
  /** Its name, as the extension writes names: 1 to 64 of lowercase letters, digits and inner hyphens. */
  readonly name: string;
  /** What it is for, as its server wrote it: cleaned and capped. */
  readonly description: string;
  /** How many files its manifest lists; null for a skill its server generates (`"dynamic"`). */
  readonly files: number | null;
  /** Its entry as its server gave it, which every file read is checked against. */
  readonly entry: Skill;
}

/** A connector's skills as its server lists them, and how long the listing holds. */
export interface SkillListing {
  readonly skills: ReadonlyArray<ServedSkill>;
  /** How long its server says the listing holds, in milliseconds; null when it does not say. */
  readonly ttlMs: number | null;
}

/** One file of a skill, read and checked. */
export interface SkillFile {
  /** Its address, as the skill's entry spells it. */
  readonly uri: string;
  /** Its text, with the connector's secrets taken out and cut to size; null for a file that is not text. */
  readonly text: string | null;
  readonly mimeType: string | null;
  /** Its size in bytes, as read. */
  readonly bytes: number;
  /** Its size and digest matched the entry's; false only for a skill its server generates. */
  readonly verified: boolean;
  /** Its text was cut to the size a bot reads. */
  readonly cut: boolean;
}

/** One entry of a skill's folder: a file, or a folder within it. */
export interface SkillFolderEntry {
  /** Its path from the skill's root, `/`-separated, a folder's without a trailing slash. */
  readonly path: string;
  readonly folder: boolean;
}

/**
 * Why a skill's file or folder was not read:
 * - `unlisted`: the skill's entry lists no such file, or the path leaves the skill;
 * - `mismatch`: what the server sent is not what the entry says (size, digest
 *   or frontmatter), so it is not used;
 * - `gone`: the server no longer serves it.
 */
export type SkillReadRefusal = "unlisted" | "mismatch" | "gone";

export type SkillRead<A> =
  | { readonly _tag: "read"; readonly value: A }
  | { readonly _tag: "refused"; readonly reason: SkillReadRefusal };

/** How a session makes the extension's requests as its own. */
export interface SkillRequests {
  /**
   * One request within `deadline`, its answers counted against `budget`
   * bytes, with what takes the connector's secrets out of its answer.
   */
  readonly send: <A>(
    deadline: Duration.Duration,
    budget: number,
    send: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<
    { readonly value: A; readonly scrub: (text: string) => string },
    ConnectorFailure
  >;
  readonly listDeadline: Duration.Duration;
  readonly readDeadline: Duration.Duration;
  readonly maxCatalogBytes: number;
  readonly maxResultCharacters: number;
  /** The SDK's own timeout for a request with `deadline`, beyond it. */
  readonly timeout: (deadline: Duration.Duration) => number;
}

/**
 * The skill's entry as J3 Bots keeps it; null when it can't be named to a
 * bot (its address carries a secret or isn't one line) or is larger than
 * the extension's limits, which J3 Bots declines.
 */
export const servedOf = (entry: Skill, redact: (text: string) => string): ServedSkill | null => {
  const { uri } = entry;
  if (uri.length > MAX_SKILL_URI || cleanText(uri) !== uri || /\s/u.test(uri)) return null;
  if (redact(uri) !== uri) return null;
  if (entry.resources !== "dynamic") {
    if (entry.resources.length > MAX_SKILL_FILES) return null;
    if (entry.resources.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL_BYTES) return null;
  }
  const description = cleanDescription(redact(entry.frontmatter.description));
  if (description === "") return null;
  return {
    uri,
    // The SDK checked it against the extension's naming rule and the last segment of the address.
    name: entry.frontmatter.name,
    description,
    files: entry.resources === "dynamic" ? null : entry.resources.length,
    entry,
  };
};

/**
 * `path` as a path within a skill, `/`-separated, without leading or
 * trailing slashes; null when it is an address, leaves the skill (`..`), or
 * carries a query or fragment.
 */
export const skillPath = (path: string): string | null => {
  const trimmed = path
    .trim()
    .replace(/^\.?\/+/u, "")
    .replace(/\/+$/u, "");
  if (/[\\?#]|:\/\//u.test(trimmed) || cleanText(trimmed) !== trimmed) return null;
  const segments = trimmed === "" ? [] : trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
};

/** The server said it serves no such skill, file or folder (`-32602`, as the extension has it). */
const isUnknown = (error: unknown): boolean =>
  ProtocolError.isInstance(error) && error.code === -32602;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 text of `bytes`, or null when they are not text. */
const textOf = (bytes: Uint8Array): string | null => {
  try {
    const text = decoder.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

const cut = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  const end = codePointsEnd(text, max);
  return end === null ? { text, cut: false } : { text: text.slice(0, end), cut: true };
};

/** A skill's root: its `SKILL.md`'s address without `/SKILL.md`. */
const rootOf = (skill: ServedSkill): string => skill.uri.slice(0, -"/SKILL.md".length);

/** What a skill's manifest holds directly under `folder` (`""` for its root); null when nothing is there. */
const manifestFolder = (
  skill: ServedSkill,
  files: ReadonlyArray<{ readonly uri: string }>,
  folder: string,
): ReadonlyArray<SkillFolderEntry> | null => {
  const root = `${rootOf(skill)}/`;
  const prefix = folder === "" ? "" : `${folder}/`;
  const entries = new Map<string, boolean>();
  for (const file of files) {
    if (!file.uri.startsWith(root)) continue;
    const relative = file.uri.slice(root.length);
    if (!relative.startsWith(prefix)) continue;
    const [first, ...rest] = relative.slice(prefix.length).split("/");
    if (first === undefined || first === "") continue;
    const path = `${prefix}${first}`;
    entries.set(path, entries.get(path) === true || rest.length > 0);
  }
  if (entries.size === 0) return null;
  return [...entries]
    .map(([path, isFolder]) => ({ path, folder: isFolder }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** The extension's requests a session makes: none to a server that did not declare it. */
export interface SessionSkills {
  /** The server declared the extension. */
  readonly offered: boolean;
  /** It also reads folders (`resources/directory/read`). */
  readonly folders: boolean;
  /** Every skill it lists, each page walked, those J3 Bots can't load left out. */
  readonly listSkills: Effect.Effect<SkillListing, ConnectorFailure>;
  readonly getSkill: (uri: string) => Effect.Effect<ServedSkill | null, ConnectorFailure>;
  readonly readSkillFile: (
    skill: ServedSkill,
    path?: string,
  ) => Effect.Effect<SkillRead<SkillFile>, ConnectorFailure>;
  readonly listSkillFolder: (
    skill: ServedSkill,
    path: string,
  ) => Effect.Effect<SkillRead<ReadonlyArray<SkillFolderEntry>>, ConnectorFailure>;
}

/**
 * The extension's requests over a connected client: list a server's skills,
 * get one by address, read one of its files, list one of its folders.
 */
export const skillsOf = (client: Client, requests: SkillRequests): SessionSkills => {
  const skills = new SkillsClient(client, { skipInvalid: true });
  const { send } = requests;
  const offered = skills.supported;
  const folders = skills.directoryRead;
  const readOptions = (signal: AbortSignal) => ({
    signal,
    timeout: requests.timeout(requests.readDeadline),
  });

  const listSkills: Effect.Effect<SkillListing, ConnectorFailure> = offered
    ? Effect.map(
        send(requests.listDeadline, requests.maxCatalogBytes, (signal) =>
          skills.list({}, { signal, timeout: requests.timeout(requests.listDeadline) }),
        ),
        ({ value, scrub }): SkillListing => ({
          skills: value.skills.flatMap((entry) => {
            const served = servedOf(entry, scrub);
            return served === null ? [] : [served];
          }),
          ttlMs: value.ttlMs ?? null,
        }),
      )
    : Effect.succeed({ skills: [], ttlMs: null });

  /**
   * The skill at `uri`, listed or not, as its server says it is now; null
   * when it serves none there, or one J3 Bots can't load.
   */
  const getSkill = (uri: string): Effect.Effect<ServedSkill | null, ConnectorFailure> =>
    offered
      ? send(requests.readDeadline, requests.maxCatalogBytes, (signal) =>
          skills.get(uri, readOptions(signal)).then(
            ({ skill }) => skill,
            (error: unknown) => {
              if (isUnknown(error)) return null;
              throw error;
            },
          ),
        ).pipe(Effect.map(({ value, scrub }) => (value === null ? null : servedOf(value, scrub))))
      : Effect.succeed(null);

  /**
   * Reads `path` of `skill`, from its root, or its `SKILL.md` when left out,
   * checked against the skill's entry: a file the entry does not list is
   * never asked for, and one whose size, digest or frontmatter differs from
   * the entry's is not used.
   */
  const readSkillFile = (
    skill: ServedSkill,
    path?: string,
  ): Effect.Effect<SkillRead<SkillFile>, ConnectorFailure> => {
    const within = path === undefined ? undefined : skillPath(path);
    if (within === null || within === "") {
      return Effect.succeed({ _tag: "refused", reason: "unlisted" });
    }
    return send(requests.readDeadline, MAX_SKILL_READ_BYTES, (signal) =>
      skills.read(skill.entry, within, readOptions(signal)).then(
        (file) => ({ _tag: "read", file }) as const,
        (error: unknown) => {
          if (SkillVerificationError.isInstance(error)) {
            const reason = error.reason === "unlisted" ? "unlisted" : "mismatch";
            return { _tag: "refused", reason } as const;
          }
          if (isUnknown(error)) return { _tag: "refused", reason: "gone" } as const;
          throw error;
        },
      ),
    ).pipe(
      Effect.map(({ value, scrub }): SkillRead<SkillFile> => {
        if (value._tag === "refused") return value;
        const { file } = value;
        // Checked as sent, then the connector's secrets taken out of what a bot reads.
        const raw = file.text ?? textOf(file.bytes);
        const text = raw === null ? null : cut(scrub(raw), requests.maxResultCharacters);
        return {
          _tag: "read",
          value: {
            uri: file.uri,
            text: text?.text ?? null,
            mimeType: file.mimeType ?? null,
            bytes: file.bytes.byteLength,
            verified: file.verified,
            cut: text?.cut ?? false,
          },
        };
      }),
    );
  };

  /**
   * What the folder `path` of `skill` holds, from its root: from the skill's
   * manifest when it has one, which is all that may be read of it; from its
   * server, for a skill it generates, when it reads folders.
   */
  const listSkillFolder = (
    skill: ServedSkill,
    path: string,
  ): Effect.Effect<SkillRead<ReadonlyArray<SkillFolderEntry>>, ConnectorFailure> => {
    const folder = skillPath(path);
    if (folder === null) return Effect.succeed({ _tag: "refused", reason: "unlisted" });
    if (skill.entry.resources !== "dynamic") {
      const entries = manifestFolder(skill, skill.entry.resources, folder);
      return Effect.succeed(
        entries === null
          ? { _tag: "refused", reason: "unlisted" }
          : { _tag: "read", value: entries },
      );
    }
    if (!folders) return Effect.succeed({ _tag: "refused", reason: "unlisted" });
    const uri = folder === "" ? rootOf(skill) : `${rootOf(skill)}/${folder}`;
    return send(requests.readDeadline, requests.maxCatalogBytes, (signal) =>
      skills.readDirectory(uri, readOptions(signal)).then(
        ({ resources }) => ({ _tag: "read", resources }) as const,
        (error: unknown) => {
          if (isUnknown(error)) return { _tag: "refused", reason: "gone" } as const;
          throw error;
        },
      ),
    ).pipe(
      Effect.map(({ value, scrub }): SkillRead<ReadonlyArray<SkillFolderEntry>> => {
        if (value._tag === "refused") return value;
        // Only what lies directly in the folder asked for, named without a secret.
        const prefix = folder === "" ? "" : `${folder}/`;
        const entries = value.resources.flatMap((resource) => {
          if (!resource.uri.startsWith(`${uri}/`)) return [];
          const name = resource.uri.slice(uri.length + 1).replace(/\/$/u, "");
          if (skillPath(name) !== name || name.includes("/") || scrub(name) !== name) return [];
          return [{ path: `${prefix}${name}`, folder: resource.mimeType === DIRECTORY_MIME_TYPE }];
        });
        return { _tag: "read", value: entries };
      }),
    );
  };

  return { offered, folders, listSkills, getSkill, readSkillFile, listSkillFolder };
};
