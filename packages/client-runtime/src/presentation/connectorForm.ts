// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ConnectorCommand,
  type ConnectorField,
  type ConnectorFieldValue,
  ConnectorSource,
  EnvName,
  type FieldKey,
  HeaderName,
  Label,
  type ListingRef,
  OAuthClientInput,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// The forms that add a connector, as the operator fills them in, and the
// source each one sends. Every value the operator typed is redacted here, the
// moment it leaves the form, and the server checks each again.

/** A row of a list of names and values: a header, or an environment variable. */
export interface PairInput {
  readonly name: string;
  readonly value: string;
}

/** An OAuth client as its fields hold it: the issuer it is registered at, its id and its secret. */
export interface ClientInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * What a form got wrong, each where the operator typed it: a field the
 * listing requires left empty (`missing`), an argument too long for a command
 * (`args`), a client's issuer that is not an https: address (`issuer`), or the rows of `headers` and `env` whose names do not fit.
 */
export interface FormProblems {
  readonly name: boolean;
  readonly url: boolean;
  readonly command: boolean;
  readonly args: boolean;
  readonly issuer: boolean;
  readonly clientId: boolean;
  readonly missing: ReadonlyArray<FieldKey>;
  readonly headers: ReadonlyArray<number>;
  readonly env: ReadonlyArray<number>;
}

export type SourceDraft =
  | { readonly _tag: "ready"; readonly source: ConnectorSource }
  | { readonly _tag: "invalid"; readonly problems: FormProblems };

const noProblems: FormProblems = {
  name: false,
  url: false,
  command: false,
  args: false,
  issuer: false,
  clientId: false,
  missing: [],
  headers: [],
  env: [],
};

const hasProblems = (problems: FormProblems) =>
  problems.name ||
  problems.url ||
  problems.command ||
  problems.args ||
  problems.issuer ||
  problems.clientId ||
  problems.missing.length > 0 ||
  problems.headers.length > 0 ||
  problems.env.length > 0;

const decodeLabel = Schema.decodeUnknownOption(Label);
const [, remoteFields, commandFields] = ConnectorSource.members;
const decodeAddress = Schema.decodeUnknownOption(remoteFields.fields.url);
const decodeArgs = Schema.decodeUnknownOption(commandFields.fields.args);
const decodeHeaderName = Schema.decodeUnknownOption(HeaderName);
const decodeEnvName = Schema.decodeUnknownOption(EnvName);
const decodeIssuer = Schema.decodeUnknownOption(OAuthClientInput.fields.issuer);
const isCommand = Schema.is(ConnectorCommand.fields.command);

/** The host of an address the operator typed, read before it is redacted, or none when it is not one. */
const hostOf = (text: string): Option.Option<string> =>
  URL.canParse(text) ? Option.some(new URL(text).hostname) : Option.none();

/** A row the operator left blank, which the form drops rather than refuses. */
const blank = (pair: PairInput) => pair.name.trim() === "" && pair.value === "";

/**
 * The client the operator typed: `none` when every field is empty, or the
 * fields it still needs, since the server uses a client only with the issuer
 * it names.
 */
type ClientDraft =
  | { readonly _tag: "none" }
  | { readonly _tag: "ready"; readonly client: OAuthClientInput }
  | { readonly _tag: "invalid"; readonly issuer: boolean; readonly clientId: boolean };

const clientDraft = (input: ClientInput): ClientDraft => {
  const typedIssuer = input.issuer.trim();
  const clientId = input.clientId.trim();
  if (typedIssuer === "" && clientId === "" && input.clientSecret === "") return { _tag: "none" };
  const issuer = decodeIssuer(typedIssuer);
  if (Option.isNone(issuer) || clientId === "") {
    return { _tag: "invalid", issuer: Option.isNone(issuer), clientId: clientId === "" };
  }
  return {
    _tag: "ready",
    client: {
      issuer: issuer.value,
      clientId,
      clientSecret: input.clientSecret === "" ? null : Redacted.make(input.clientSecret),
    },
  };
};

/**
 * The rows that name something, each decoded, and the index of each whose
 * name does not fit; blank rows are dropped.
 */
const pairs = <N>(
  rows: ReadonlyArray<PairInput>,
  decodeName: (name: string) => Option.Option<N>,
): {
  readonly decoded: ReadonlyArray<{ readonly name: N; readonly value: Redacted.Redacted<string> }>;
  readonly refused: ReadonlyArray<number>;
} => {
  const decoded: Array<{ readonly name: N; readonly value: Redacted.Redacted<string> }> = [];
  const refused: Array<number> = [];
  rows.forEach((row, index) => {
    if (blank(row)) return;
    const name = decodeName(row.name.trim());
    if (Option.isSome(name)) decoded.push({ name: name.value, value: Redacted.make(row.value) });
    else refused.push(index);
  });
  return { decoded, refused };
};

/** The client of an entry that takes one, which it needs: left empty, it is missing both fields. */
const requiredClient = (input: ClientInput): ClientDraft => {
  const draft = clientDraft(input);
  return draft._tag === "none" ? { _tag: "invalid", issuer: true, clientId: true } : draft;
};

/**
 * The values a connector's fields took, each redacted: an empty one left out,
 * and the key of each required one left empty under `missing`. A secret is
 * kept as typed, since spaces may be part of it; any other value is trimmed.
 */
export function fieldValues(
  fields: ReadonlyArray<ConnectorField>,
  typed: ReadonlyMap<FieldKey, string>,
):
  | { readonly _tag: "ready"; readonly values: ReadonlyArray<ConnectorFieldValue> }
  | { readonly _tag: "invalid"; readonly missing: ReadonlyArray<FieldKey> } {
  const values: Array<ConnectorFieldValue> = [];
  const missing: Array<FieldKey> = [];
  for (const field of fields) {
    const raw = typed.get(field.key) ?? "";
    const value = field.secret ? raw : raw.trim();
    if (value !== "") values.push({ key: field.key, value: Redacted.make(value) });
    else if (field.required) missing.push(field.key);
  }
  return missing.length > 0 ? { _tag: "invalid", missing } : { _tag: "ready", values };
}

/**
 * What a form keeps of `typed` once the server took it: the values of its
 * plain fields, and none of its secret ones.
 */
export const withoutSecrets = (
  fields: ReadonlyArray<ConnectorField>,
  typed: ReadonlyMap<FieldKey, string>,
): ReadonlyMap<FieldKey, string> =>
  new Map([...typed].filter(([key]) => !fields.some((field) => field.key === key && field.secret)));

/**
 * A gallery entry's form: a value for each of its fields, as `fieldValues`
 * takes them, and for an `own-app` entry the client the operator registered.
 */
export function listingSource(input: {
  readonly ref: ListingRef;
  readonly fields: ReadonlyArray<ConnectorField>;
  readonly values: ReadonlyMap<FieldKey, string>;
  /** Null for an entry that takes no client. */
  readonly client: ClientInput | null;
}): SourceDraft {
  const values = fieldValues(input.fields, input.values);
  const oauthClient: ClientDraft =
    input.client === null ? { _tag: "none" } : requiredClient(input.client);
  const problems: FormProblems = {
    ...noProblems,
    missing: values._tag === "invalid" ? values.missing : [],
    issuer: oauthClient._tag === "invalid" && oauthClient.issuer,
    clientId: oauthClient._tag === "invalid" && oauthClient.clientId,
  };
  if (values._tag === "invalid" || hasProblems(problems) || oauthClient._tag === "invalid") {
    return { _tag: "invalid", problems };
  }
  return {
    _tag: "ready",
    source: {
      _tag: "listing",
      ref: input.ref,
      values: values.values,
      oauthClient: oauthClient._tag === "ready" ? oauthClient.client : null,
    },
  };
}

/**
 * A connector added by its address. Without a name it takes the address's
 * host. `privateNetwork` is what the operator confirmed, once the server
 * refused the address as one in their own network.
 */
export function remoteSource(input: {
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<PairInput>;
  readonly client: ClientInput;
  readonly privateNetwork: boolean;
}): SourceDraft {
  const typedUrl = input.url.trim();
  const url = decodeAddress(Redacted.make(typedUrl));
  const typedName = input.name.trim();
  const host = hostOf(typedUrl);
  const name = decodeLabel(typedName === "" && Option.isSome(host) ? host.value : typedName);
  const headers = pairs(input.headers, (text) => decodeHeaderName(text));
  const oauthClient = clientDraft(input.client);
  const problems: FormProblems = {
    ...noProblems,
    name: Option.isSome(url) && Option.isNone(name),
    url: Option.isNone(url),
    issuer: oauthClient._tag === "invalid" && oauthClient.issuer,
    clientId: oauthClient._tag === "invalid" && oauthClient.clientId,
    headers: headers.refused,
  };
  if (
    hasProblems(problems) ||
    Option.isNone(url) ||
    Option.isNone(name) ||
    oauthClient._tag === "invalid"
  ) {
    return { _tag: "invalid", problems };
  }
  return {
    _tag: "ready",
    source: {
      _tag: "remote",
      name: name.value,
      url: url.value,
      headers: headers.decoded,
      oauthClient: oauthClient._tag === "ready" ? oauthClient.client : null,
      privateNetwork: input.privateNetwork,
    },
  };
}

/**
 * A connector the server starts by command: its arguments one per line, as
 * typed, each redacted, blank lines dropped, and its environment.
 */
export function commandSource(input: {
  readonly name: string;
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<PairInput>;
}): SourceDraft {
  const command = input.command.trim();
  const name = decodeLabel(input.name.trim());
  const args = input.args
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => Redacted.make(line));
  const decodedArgs = decodeArgs(args);
  const env = pairs(input.env, (text) => decodeEnvName(text));
  const problems: FormProblems = {
    ...noProblems,
    name: Option.isNone(name),
    command: !isCommand(command),
    args: Option.isNone(decodedArgs),
    env: env.refused,
  };
  if (hasProblems(problems) || Option.isNone(name) || Option.isNone(decodedArgs)) {
    return { _tag: "invalid", problems };
  }
  return {
    _tag: "ready",
    source: {
      _tag: "command",
      name: name.value,
      command,
      args: decodedArgs.value,
      env: env.decoded,
    },
  };
}
