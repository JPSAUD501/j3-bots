// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AskedValues } from "@j3-bots/client-runtime";
import { typedOrigins } from "@j3-bots/client-runtime/presentation";
import {
  type BotId,
  type LoginOrigins,
  type Secret,
  type SecretAccess,
  type SecretAskEntry,
  type SecretAskValue,
  SecretChanges,
  SecretDraft,
  SecretName,
  type SecretRequestFieldId,
  SecretValue,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const decodeName = Schema.decodeUnknownOption(SecretName);
const decodeDraft = Schema.decodeUnknownOption(SecretDraft);
const decodeChanges = Schema.decodeUnknownOption(SecretChanges);
const decodeValue = Schema.decodeUnknownOption(SecretValue);

/** The name typed, as a secret takes it; none while it breaks the rule `SecretName` states. */
export const secretNameOf = (typed: string): Option.Option<SecretName> => decodeName(typed.trim());

/** A login's values, as typed. An empty one-time code key is none. */
export interface TypedLogin {
  readonly username: string;
  readonly password: string;
  readonly totp: string;
}

const typedTotp = (totp: string): Redacted.Redacted<string> | null =>
  totp.trim() === "" ? null : Redacted.make(totp.trim());

/** A new login for `origins`; none while its password is empty or a value is too long. */
export const loginDraft = (origins: LoginOrigins, typed: TypedLogin): Option.Option<SecretDraft> =>
  decodeDraft({
    _tag: "login",
    origins,
    username: Redacted.make(typed.username),
    password: Redacted.make(typed.password),
    totp: typedTotp(typed.totp),
  });

/** A new single value, exactly as typed; none while it is empty or too long. */
export const valueDraft = (value: string): Option.Option<SecretDraft> =>
  decodeDraft({ _tag: "value", value: Redacted.make(value) });

/** What the operator typed into a bot's ask: a login's values, or the value. */
export interface TypedAsk extends TypedLogin {
  readonly value: string;
}

/** The secret a bot's ask saves: a login for the site it named, or the value. */
export const askDraft = (
  secret: SecretAskEntry["secret"],
  typed: TypedAsk,
): Option.Option<SecretDraft> => {
  if (secret._tag === "value") return valueDraft(typed.value);
  const origins: LoginOrigins = [secret.origin];
  return loginDraft(origins, typed);
};

/**
 * Which bots may use what a bot's ask saves: every bot, or only the bot that
 * asked. The server lets that bot use it whatever the access names; naming it
 * says so here too.
 */
export const askAccess = (everyBot: boolean, asking: BotId | null): SecretAccess =>
  everyBot ? { _tag: "every-bot" } : { _tag: "bots", botIds: asking === null ? [] : [asking] };

/**
 * The values a bot's ask for several saves, each under the name the bot
 * asked for it by; none while one is empty or too long, or a name is one no
 * secret takes. Space around a pasted value is never part of it.
 */
export const askedValues = (
  entry: SecretAskEntry,
  asked: ReadonlyArray<SecretAskValue>,
  typed: ReadonlyMap<SecretRequestFieldId, string>,
  access: SecretAccess,
): Option.Option<AskedValues> => {
  const values: Array<AskedValues["values"][number]> = [];
  for (const each of asked) {
    const name = secretNameOf(each.name);
    const value = decodeValue(Redacted.make((typed.get(each.id) ?? "").trim()));
    if (Option.isNone(name) || Option.isNone(value)) return Option.none();
    values.push({ field: each.id, name: name.value, value: value.value });
  }
  return Option.some({ request: entry.id, access, values });
};

/** What the operator typed to change a secret. A value left empty keeps the one it has. */
export interface TypedEdit {
  readonly name: string;
  /** A login's sites, one per line. */
  readonly sites: string;
  readonly username: string;
  readonly password: string;
  readonly totp: string;
  readonly removeTotp: boolean;
  readonly value: string;
}

/**
 * What changing `secret` as typed changes: its name and a login's sites when
 * they differ, and each value typed. None while the name or the sites are not
 * ones a secret takes, or a value is too long.
 */
export const secretChanges = (secret: Secret, typed: TypedEdit): Option.Option<SecretChanges> => {
  const name = secretNameOf(typed.name);
  if (Option.isNone(name)) return Option.none();
  const renamed = name.value === secret.name ? {} : { name: name.value };
  if (secret.kind._tag === "value") {
    return decodeChanges({
      ...renamed,
      ...(typed.value === "" ? {} : { value: Redacted.make(typed.value) }),
    });
  }
  const origins = typedOrigins(typed.sites);
  if (Option.isNone(origins)) return Option.none();
  const totp = typedTotp(typed.totp);
  return decodeChanges({
    ...renamed,
    ...(origins.value.join("\n") === secret.kind.origins.join("\n")
      ? {}
      : { origins: origins.value }),
    ...(typed.username === "" ? {} : { username: Redacted.make(typed.username) }),
    ...(typed.password === "" ? {} : { password: Redacted.make(typed.password) }),
    ...(typed.removeTotp ? { totp: null } : totp === null ? {} : { totp }),
  });
};
