// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_SECRET_NAME_LENGTH, type SecretAccess, SecretName } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// How a bot names a secret it may use, and where the server puts its value
// (docs/architecture/server.md, "Secrets"). A bot is handed `secret:<name>`;
// in a connector's header, argument or environment value it writes
// `${secret:<name>}`, or `${secret:<name>.username}` for a login's user name.
// A login's bare reference is its password.

/** One reference: the secret's name and, for a login, which of its values. */
export interface SecretReference {
  readonly name: SecretName;
  /** Null for a bare reference: a single value's value, or a login's password. */
  readonly field: "username" | "password" | null;
}

const decodeName = Schema.decodeUnknownOption(SecretName);

/**
 * `${secret:<name>}` or `${secret:<name>.username}` / `.password`, anywhere in
 * a text. A name is what `SecretName` takes; anything else between `${secret:`
 * and `}` is not a reference, and stays as it is.
 */
const REFERENCE = new RegExp(
  `\\$\\{secret:([a-z0-9][a-z0-9_-]{0,${MAX_SECRET_NAME_LENGTH - 1}})(?:\\.(username|password))?\\}`,
  "g",
);

/** The references in `text`, in order, each as often as it appears. */
export const referencesIn = (text: string): ReadonlyArray<SecretReference> =>
  Array.from(text.matchAll(REFERENCE), (match) => ({
    name: SecretName.make(match[1] ?? ""),
    field: match[2] === "username" || match[2] === "password" ? match[2] : null,
  }));

/**
 * `text` with each reference replaced by its value in `values`, keyed by the
 * reference's text (`referenceText`). One missing there stays as it is.
 */
export const replaceReferences = (
  text: string,
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
): Redacted.Redacted<string> =>
  Redacted.make(
    text.replace(REFERENCE, (whole: string) => {
      const value = values.get(whole);
      return value === undefined ? whole : Redacted.value(value);
    }),
  );

/**
 * Whether a secret's `access` lets every one of `users` use it. One every
 * bot may use covers anyone; one some bots may use covers only some of them,
 * never every bot, which takes in the bots still to come.
 */
export const accessCovers = (access: SecretAccess, users: SecretAccess): boolean =>
  access._tag === "every-bot" ||
  (users._tag === "bots" && users.botIds.every((id) => access.botIds.includes(id)));

/** The text of a reference as it appears, the key `replaceReferences` looks it up by. */
export const referenceText = (reference: SecretReference): string =>
  `\${secret:${reference.name}${reference.field === null ? "" : `.${reference.field}`}}`;

/**
 * The name in what a bot gives for a secret: the name itself, or the
 * reference it was handed (`secret:<name>`). None when it is neither.
 */
export const nameFromBot = (given: string): Option.Option<SecretName> =>
  decodeName(given.trim().replace(/^secret:/, ""));

/**
 * A secret's name from a login's label of before secrets ("GitHub (work)"
 * gives `github-work`): lower case, letters and digits without their accents,
 * every other run of characters one `-`, cut to the longest name. `login` when
 * nothing of it is left. `taken` names are passed over with a number after.
 */
export const nameFromLabel = (label: string, taken: ReadonlySet<string>): SecretName => {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SECRET_NAME_LENGTH)
      .replace(/-+$/, "") || "login";
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${base.slice(0, MAX_SECRET_NAME_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return SecretName.make(candidate);
  }
};
