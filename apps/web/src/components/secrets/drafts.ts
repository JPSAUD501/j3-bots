// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NewSecret } from "@j3-bots/client-runtime";
import { typedOrigins } from "@j3-bots/client-runtime/presentation";
import {
  type BotId,
  type LoginOrigins,
  type SecretAccess,
  type SecretAskEntry,
  SecretChanges,
  SecretDraft,
  SecretName,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const decodeName = Schema.decodeUnknownOption(SecretName);
const decodeDraft = Schema.decodeUnknownOption(SecretDraft);
const decodeChanges = Schema.decodeUnknownOption(SecretChanges);

/** A secret's name as typed, as the contract takes it; none when it breaks the name's rules. */
const typedName = (typed: string): Option.Option<SecretName> => decodeName(typed.trim());

/** A one-time code key as typed: none when the field is empty. */
const typedTotp = (typed: string): Redacted.Redacted<string> | null =>
  typed.trim() === "" ? null : Redacted.make(typed.trim());

/** What the operator typed for a login. */
interface TypedLogin {
  readonly username: string;
  readonly password: string;
  readonly totp: string;
}

/** Why what was typed is not a secret yet, by the field that says so. */
export type DraftProblem = "name" | "sites" | "password" | "value";

export type Drafted<A> =
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "invalid"; readonly problem: DraftProblem };

const invalid = (problem: DraftProblem): Drafted<never> => ({ _tag: "invalid", problem });

/**
 * What the contract made of the typed values, or `problem` when it refused
 * them. The fields take no more than the contract does, so what is left to
 * refuse is the field `problem` names.
 */
const decoded = <A>(found: Option.Option<A>, problem: DraftProblem): Drafted<A> =>
  Option.match(found, {
    onSome: (value) => ({ _tag: "ready", value }),
    onNone: () => invalid(problem),
  });

/** A login's values for `origins`, as `secrets.add` takes them. */
const loginDraft = (origins: LoginOrigins, typed: TypedLogin): Drafted<SecretDraft> =>
  typed.password === ""
    ? invalid("password")
    : decoded(
        decodeDraft({
          _tag: "login",
          origins,
          username: Redacted.make(typed.username),
          password: Redacted.make(typed.password),
          totp: typedTotp(typed.totp),
        }),
        "password",
      );

/** A single value, as `secrets.add` takes it. Space around a pasted token is never part of it. */
const valueDraft = (typed: string): Drafted<SecretDraft> =>
  typed.trim() === ""
    ? invalid("value")
    : decoded(decodeDraft({ _tag: "value", value: Redacted.make(typed.trim()) }), "value");

/**
 * Which bots may use a secret a bot asked for: every bot, or only the bot
 * that asked, which the server lets in either way.
 */
const askAccess = (everyBot: boolean, asker: BotId): SecretAccess =>
  everyBot ? { _tag: "every-bot" } : { _tag: "bots", botIds: [asker] };

/** What the operator typed into a bot's ask: a login's values, or a single value. */
export interface TypedAsk extends TypedLogin {
  readonly value: string;
}

/**
 * The secret a bot's ask saves: under the name the bot asked for, a login for
 * the site it named or a single value, for the bot that asked, or every bot.
 */
export const askedSecret = (
  entry: SecretAskEntry,
  typed: TypedAsk,
  everyBot: boolean,
): Drafted<NewSecret> => {
  // A save-login card from before secrets may carry a name no secret takes.
  const name = typedName(entry.name);
  if (Option.isNone(name)) return invalid("name");
  const draft =
    entry.secret._tag === "login"
      ? loginDraft([entry.secret.origin], typed)
      : valueDraft(typed.value);
  return draft._tag === "invalid"
    ? draft
    : {
        _tag: "ready",
        value: {
          name: name.value,
          draft: draft.value,
          access: askAccess(everyBot, entry.author.botId),
        },
      };
};

/** What the editor of a secret typed. Editing, empty values keep what the secret has. */
export interface TypedSecret {
  readonly name: string;
  readonly sites: string;
  readonly username: string;
  readonly password: string;
  readonly totp: string;
  readonly removeTotp: boolean;
  readonly value: string;
}

/** A secret the operator adds: a login (`login`) or a single value, for the bots of `access`. */
export const newSecret = (
  login: boolean,
  typed: TypedSecret,
  access: SecretAccess,
): Drafted<NewSecret> => {
  const name = typedName(typed.name);
  if (Option.isNone(name)) return invalid("name");
  let draft: Drafted<SecretDraft>;
  if (login) {
    const origins = typedOrigins(typed.sites);
    if (Option.isNone(origins)) return invalid("sites");
    draft = loginDraft(origins.value, typed);
  } else {
    draft = valueDraft(typed.value);
  }
  return draft._tag === "invalid"
    ? draft
    : { _tag: "ready", value: { name: name.value, draft: draft.value, access } };
};

/** The changes an edit makes to a login (`login`) or a single value, as `secrets.update` takes them. */
export const editChanges = (login: boolean, typed: TypedSecret): Drafted<SecretChanges> => {
  const name = typedName(typed.name);
  if (Option.isNone(name)) return invalid("name");
  if (!login) {
    return decoded(
      decodeChanges({
        name: name.value,
        ...(typed.value.trim() === "" ? {} : { value: Redacted.make(typed.value.trim()) }),
      }),
      "value",
    );
  }
  const origins = typedOrigins(typed.sites);
  if (Option.isNone(origins)) return invalid("sites");
  const totp = typedTotp(typed.totp);
  return decoded(
    decodeChanges({
      name: name.value,
      origins: origins.value,
      ...(typed.username === "" ? {} : { username: Redacted.make(typed.username) }),
      ...(typed.password === "" ? {} : { password: Redacted.make(typed.password) }),
      ...(typed.removeTotp ? { totp: null } : totp === null ? {} : { totp }),
    }),
    "password",
  );
};
