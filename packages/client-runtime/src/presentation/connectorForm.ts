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
  type OAuthClientInput,
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

/** An OAuth client as its two fields hold it. */
export interface ClientInput {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * What a form got wrong, each where the operator typed it: a field the
 * listing requires left empty (`missing`), an argument too long for a command
 * (`args`), or the rows of `headers` and `env` whose names do not fit.
 */
export interface FormProblems {
  readonly name: boolean;
  readonly url: boolean;
  readonly command: boolean;
  readonly args: boolean;
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
const isCommand = Schema.is(ConnectorCommand.fields.command);

/** The host of an address the operator typed, read before it is redacted, or none when it is not one. */
const hostOf = (text: string): Option.Option<string> =>
  URL.canParse(text) ? Option.some(new URL(text).hostname) : Option.none();

/** A row the operator left blank, which the form drops rather than refuses. */
const blank = (pair: PairInput) => pair.name.trim() === "" && pair.value === "";

/** The client, or null when both its fields are empty; a secret without an id is a problem. */
const client = (input: ClientInput | null): Option.Option<OAuthClientInput | null> => {
  if (input === null) return Option.some(null);
  const clientId = input.clientId.trim();
  if (clientId === "") return input.clientSecret === "" ? Option.some(null) : Option.none();
  return Option.some({
    clientId,
    clientSecret: input.clientSecret === "" ? null : Redacted.make(input.clientSecret),
  });
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
  const oauthClient = client(input.client);
  const clientMissing =
    input.client !== null && (Option.isNone(oauthClient) || oauthClient.value === null);
  const problems = {
    ...noProblems,
    missing: values._tag === "invalid" ? values.missing : [],
    clientId: clientMissing,
  };
  if (values._tag === "invalid" || hasProblems(problems) || Option.isNone(oauthClient)) {
    return { _tag: "invalid", problems };
  }
  return {
    _tag: "ready",
    source: {
      _tag: "listing",
      ref: input.ref,
      values: values.values,
      oauthClient: oauthClient.value,
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
  readonly client: ClientInput | null;
  readonly privateNetwork: boolean;
}): SourceDraft {
  const typedUrl = input.url.trim();
  const url = decodeAddress(Redacted.make(typedUrl));
  const typedName = input.name.trim();
  const host = hostOf(typedUrl);
  const name = decodeLabel(typedName === "" && Option.isSome(host) ? host.value : typedName);
  const headers = pairs(input.headers, (text) => decodeHeaderName(text));
  const oauthClient = client(input.client);
  const problems: FormProblems = {
    ...noProblems,
    name: Option.isSome(url) && Option.isNone(name),
    url: Option.isNone(url),
    clientId: Option.isNone(oauthClient),
    headers: headers.refused,
  };
  if (
    hasProblems(problems) ||
    Option.isNone(url) ||
    Option.isNone(name) ||
    Option.isNone(oauthClient)
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
      oauthClient: oauthClient.value,
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
