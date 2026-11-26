// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- what a connector's references resolved to is compared by a SHA-256 of it, so no value is kept to compare.
import * as NodeCrypto from "node:crypto";
import { type SecretNeed, SecretNeeded, SecretsUnavailable } from "@j3-bots/connectors";
import type { ConnectorGrant, SecretAccess } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { ConnectorSecret } from "../secrets/ConnectorSecret.ts";
import {
  referencesIn,
  referenceText,
  replaceReferences,
  type SecretReference,
} from "../secrets/references.ts";
import type { SecretUnavailable } from "../secrets/Secrets.ts";

/**
 * The references to the operator's secrets (`${secret:<name>}`) in a
 * connector's settings, resolved once for the connector, not for each bot
 * (`docs/architecture/server.md`, "Secrets in a connector's settings"): the
 * listing, every bot's session and a command's one shared process are sent
 * the same values, and only while every bot the connector goes to may use
 * each secret.
 */

/**
 * The values of a connector's settings a reference resolves in: its headers',
 * its command's arguments' and its variables', and a gallery form's secret
 * values, which its headers were made from.
 */
const resolvedValues = (secret: ConnectorSecret): ReadonlyArray<Redacted.Redacted<string>> => [
  ...secret.headers.map((header) => header.value),
  ...(secret.command?.args ?? []),
  ...secret.env.map((variable) => variable.value),
  ...secret.formSecrets.map((named) => named.value),
];

/** Each reference once, in the order they first appear. */
const distinct = (references: ReadonlyArray<SecretReference>): ReadonlyArray<SecretReference> => {
  const seen = new Map<string, SecretReference>();
  for (const reference of references) {
    const text = referenceText(reference);
    if (!seen.has(text)) seen.set(text, reference);
  }
  return [...seen.values()];
};

/** The references in `values`, each once. */
const referencesInValues = (
  values: ReadonlyArray<Redacted.Redacted<string>>,
): ReadonlyArray<SecretReference> =>
  distinct(values.flatMap((value) => referencesIn(Redacted.value(value))));

/** The references a connector's settings make, each once. */
export const referencesOf = (secret: ConnectorSecret): ReadonlyArray<SecretReference> =>
  referencesInValues(resolvedValues(secret));

const decodeComponent = Option.liftThrowable(decodeURIComponent);

/**
 * A reference in a connector's address, where none is resolved: as written,
 * or percent-encoded, as a gallery form puts a value in an address.
 */
export const referenceInAddress = (
  address: Redacted.Redacted<string>,
): Option.Option<SecretReference> => {
  const text = Redacted.value(address);
  const decoded = Option.getOrElse(decodeComponent(text), () => text);
  return Option.fromNullishOr([...referencesIn(text), ...referencesIn(decoded)][0]);
};

/** A connector's settings resolved: what it sends, and the secrets' values in it, which its server's answers are scrubbed of. */
export interface Resolved {
  readonly secret: ConnectorSecret;
  readonly values: ReadonlyArray<Redacted.Redacted<string>>;
}

/**
 * A connector's settings with each reference replaced by its value in
 * `values`, keyed by the reference's text, which must hold every reference
 * `referencesOf` finds: `Secrets.referenceValues` for them gives it.
 */
export const withValues = (
  secret: ConnectorSecret,
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
): Resolved => {
  const resolve = (value: Redacted.Redacted<string>) =>
    replaceReferences(Redacted.value(value), values);
  return {
    secret: {
      ...secret,
      headers: secret.headers.map((header) => ({ ...header, value: resolve(header.value) })),
      command:
        secret.command === null
          ? null
          : { ...secret.command, args: secret.command.args.map(resolve) },
      env: secret.env.map((variable) => ({ ...variable, value: resolve(variable.value) })),
      formSecrets: secret.formSecrets.map((named) => ({ ...named, value: resolve(named.value) })),
    },
    values: [...values.values()],
  };
};

/** Who uses a connector, as a secret's access names bots. */
export const usersOf = (grant: ConnectorGrant): SecretAccess =>
  grant._tag === "all-bots" ? { _tag: "every-bot" } : { _tag: "bots", botIds: grant.ids };

/**
 * What the connector's status says of a reference that does not resolve:
 * none when only the secrets cannot be read now, which is their own status.
 */
export const needOf = (error: SecretUnavailable): Option.Option<SecretNeed> => {
  const { reason } = error;
  if (reason === "unavailable") return Option.none();
  return Option.some({
    secret: error.secret,
    reason: reason === "not-allowed" ? "not-shared" : reason,
  });
};

/** The failure a request whose settings did not resolve ends in: nothing was sent. */
export const failureOf = (error: SecretUnavailable): SecretNeeded | SecretsUnavailable =>
  Option.match(needOf(error), {
    onNone: () => new SecretsUnavailable(),
    onSome: (need) => new SecretNeeded(need),
  });

/** A digest of what references resolved to, equal while no value changed. */
export const digestOf = (values: ReadonlyMap<string, Redacted.Redacted<string>>): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        [...values]
          .map(([text, value]) => [text, Redacted.value(value)])
          .toSorted(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .digest("hex");
