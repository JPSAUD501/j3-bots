// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  codeFromSecret,
  codeVariable,
  type CommandLine,
  type Connector,
  ConnectorCommand,
  type ConnectorField,
  type ConnectorFieldValue,
  ConnectorSource,
  EnvName,
  FieldKey,
  HeaderName,
  Label,
  type Language,
  type ListingRef,
  OAuthClientInput,
  pinRefusal,
  type PinRefusal,
  reservedVariable,
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
 * Why the server would refuse one of a command's variables, by its row:
 * - `invalid`: its name is not one a shell allows;
 * - `reserved`: its name is one the server reads to find and start the
 *   program, such as `PATH` ({@link reservedVariable});
 * - `twice`: another row has its name, in any case, as Windows reads them;
 * - `code-secret`: a variable that decides which code runs, whose value is a
 *   reference to a secret rather than the value itself ({@link codeFromSecret});
 * - `value-again`: a variable left empty in a changed command line, which is
 *   sent whole, so no value is kept ({@link commandEdit}).
 */
export interface EnvProblem {
  readonly index: number;
  readonly reason: "invalid" | "reserved" | "twice" | "code-secret" | "value-again";
}

/**
 * What a form got wrong, each where the operator typed it: a field the
 * listing requires left empty (`missing`), an argument too long for a command
 * (`args`), a package a command runs at no exact version (`pin`), arguments
 * kept where a changed command needs them again (`argsAgain`), a client's
 * issuer that is not an https: address (`issuer`), the rows of `headers`
 * whose names do not fit, and the rows of `env` the server would refuse.
 */
export interface FormProblems {
  readonly name: boolean;
  readonly url: boolean;
  readonly command: boolean;
  readonly args: boolean;
  readonly pin: PinRefusal | null;
  readonly argsAgain: boolean;
  readonly issuer: boolean;
  readonly clientId: boolean;
  readonly missing: ReadonlyArray<FieldKey>;
  readonly headers: ReadonlyArray<number>;
  readonly env: ReadonlyArray<EnvProblem>;
}

export type SourceDraft =
  | { readonly _tag: "ready"; readonly source: ConnectorSource }
  | { readonly _tag: "invalid"; readonly problems: FormProblems };

const noProblems: FormProblems = {
  name: false,
  url: false,
  command: false,
  args: false,
  pin: null,
  argsAgain: false,
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
  problems.pin !== null ||
  problems.argsAgain ||
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
const decodeFieldKey = Schema.decodeUnknownOption(FieldKey);
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
function fieldValues(
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
 * The values given again for a connector's fields, as `fieldValues` takes
 * them: one left empty keeps what the server holds, so a header made of
 * several fields takes a new key alone. With none given, every field is
 * missing.
 */
export function refillValues(
  fields: ReadonlyArray<ConnectorField>,
  typed: ReadonlyMap<FieldKey, string>,
):
  | { readonly _tag: "ready"; readonly values: ReadonlyArray<ConnectorFieldValue> }
  | { readonly _tag: "invalid"; readonly missing: ReadonlyArray<FieldKey> } {
  const given = fieldValues(
    fields.map((field) => ({ ...field, required: false })),
    typed,
  );
  return given._tag === "ready" && given.values.length > 0
    ? given
    : { _tag: "invalid", missing: fields.map((field) => field.key) };
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
 * `language` is the operator's: the connector keeps its name and fields in it.
 */
export function listingSource(input: {
  readonly ref: ListingRef;
  readonly language: Language;
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
      language: input.language,
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

/** Arguments as the operator typed them: one per line, each trimmed, blank lines dropped. */
const argumentsOf = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * A command's variables as the server would take them: each row that names
 * something, decoded, and each the server would refuse, with why.
 */
const variables = (
  rows: ReadonlyArray<PairInput>,
): {
  readonly decoded: CommandLine["env"];
  readonly problems: ReadonlyArray<EnvProblem>;
} => {
  const decoded: Array<CommandLine["env"][number]> = [];
  const problems: Array<EnvProblem> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (blank(row)) return;
    const name = decodeEnvName(row.name.trim());
    if (Option.isNone(name)) {
      problems.push({ index, reason: "invalid" });
      return;
    }
    const folded = name.value.toUpperCase();
    if (reservedVariable(name.value)) problems.push({ index, reason: "reserved" });
    else if (seen.has(folded)) problems.push({ index, reason: "twice" });
    else if (codeFromSecret(name.value, row.value)) {
      problems.push({ index, reason: "code-secret" });
    }
    seen.add(folded);
    decoded.push({ name: name.value, value: Redacted.make(row.value) });
  });
  return { decoded, problems };
};

/**
 * A command line as the operator typed it, as `connector.add` and
 * `connector.update` take it, or what the server would refuse in it: a
 * package `npx` or `uvx` would fetch at no exact version among them
 * ({@link pinRefusal}).
 */
const commandLine = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: ReadonlyArray<PairInput>;
}):
  | { readonly _tag: "ready"; readonly command: CommandLine }
  | { readonly _tag: "invalid"; readonly problems: FormProblems } => {
  const command = input.command.trim();
  const args = decodeArgs(input.args.map((arg) => Redacted.make(arg)));
  const env = variables(input.env);
  const program = isCommand(command);
  const problems: FormProblems = {
    ...noProblems,
    command: !program,
    args: Option.isNone(args),
    pin: program
      ? Option.getOrNull(
          pinRefusal(
            command,
            input.args,
            env.decoded.map((variable) => variable.name),
          ),
        )
      : null,
    env: env.problems,
  };
  if (hasProblems(problems) || Option.isNone(args)) return { _tag: "invalid", problems };
  return { _tag: "ready", command: { command, args: args.value, env: env.decoded } };
};

/**
 * A connector the server starts by command: its arguments one per line, as
 * typed, each redacted, blank lines dropped, and its environment. The
 * operator confirms it ({@link commandConsent}) before it is sent.
 */
export function commandSource(input: {
  readonly name: string;
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<PairInput>;
}): SourceDraft {
  const name = decodeLabel(input.name.trim());
  const line = commandLine({ ...input, args: argumentsOf(input.args) });
  const problems: FormProblems = {
    ...(line._tag === "invalid" ? line.problems : noProblems),
    name: Option.isNone(name),
  };
  if (line._tag === "invalid" || Option.isNone(name)) return { _tag: "invalid", problems };
  return { _tag: "ready", source: { _tag: "command", name: name.value, ...line.command } };
}

/**
 * What the client knows of a command connector's command line: its program
 * and its variables' names. Its arguments stay on the server, since one can
 * carry a key, and so do its values.
 */
export interface KnownCommand {
  readonly program: string;
  readonly names: ReadonlyArray<string>;
}

/**
 * The arguments in a command connector's edit form: those it runs with,
 * which the client never sees, or a new list typed in full.
 */
export type ArgumentsDraft =
  | { readonly _tag: "kept" }
  | { readonly _tag: "typed"; readonly text: string };

/**
 * What an edit of a command connector sends:
 * - `unchanged`: nothing;
 * - `values`: new values for variables it has, each one left empty keeping
 *   its own. The command line is the one the operator confirmed, so it runs
 *   with no confirmation;
 * - `command`: a new command line, sent whole, which the operator confirms
 *   first, as when it was added: its program, its arguments or a variable's
 *   name changed, or a variable was added or removed.
 */
export type CommandEdit =
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "values"; readonly values: ReadonlyArray<ConnectorFieldValue> }
  | { readonly _tag: "command"; readonly command: CommandLine }
  | { readonly _tag: "invalid"; readonly problems: FormProblems };

/**
 * Whether an edit keeps the command line the server has: the same program,
 * the arguments kept, the same variable names, and no new value for a
 * variable that decides which code runs ({@link codeVariable}), whose value
 * is part of the line. Only then does an empty value keep its own; any other
 * change sends the whole line, every value with it.
 */
export function keepsLine(
  known: KnownCommand,
  draft: {
    readonly command: string;
    readonly args: ArgumentsDraft;
    readonly env: ReadonlyArray<PairInput>;
  },
): boolean {
  const rows = draft.env.filter((row) => !blank(row));
  const names = rows.map((row) => row.name.trim());
  return (
    draft.command.trim() === known.program &&
    draft.args._tag === "kept" &&
    names.length === known.names.length &&
    known.names.every((name) => names.includes(name)) &&
    !rows.some((row) => row.value !== "" && codeVariable(row.name.trim()))
  );
}

/**
 * An edit of a command connector, as its form holds it. Changing only
 * values keeps the command line, which the server holds and the client never
 * sees. Anything else sends a new one whole: its arguments typed again, and
 * every variable's value, since the server keeps none of the old line.
 */
export function commandEdit(
  known: KnownCommand,
  draft: {
    readonly command: string;
    readonly args: ArgumentsDraft;
    readonly env: ReadonlyArray<PairInput>;
  },
): CommandEdit {
  const rows = draft.env.filter((row) => !blank(row));
  if (keepsLine(known, draft)) {
    const values = rows.flatMap((row): ReadonlyArray<ConnectorFieldValue> => {
      const key = decodeFieldKey(row.name.trim());
      return row.value === "" || Option.isNone(key)
        ? []
        : [{ key: key.value, value: Redacted.make(row.value) }];
    });
    return values.length === 0 ? { _tag: "unchanged" } : { _tag: "values", values };
  }
  const line = commandLine({
    command: draft.command,
    args: draft.args._tag === "typed" ? argumentsOf(draft.args.text) : [],
    env: draft.env,
  });
  const base = line._tag === "invalid" ? line.problems : noProblems;
  // No variable keeps a value the client never saw, a renamed one included,
  // so an empty one would be saved empty: each is given again.
  const again = draft.env.flatMap((row, index): ReadonlyArray<EnvProblem> =>
    !blank(row) && row.value === "" && !base.env.some((problem) => problem.index === index)
      ? [{ index, reason: "value-again" }]
      : [],
  );
  const kept = draft.args._tag === "kept";
  const problems: FormProblems = {
    ...base,
    argsAgain: kept,
    // Which package runs is told by the arguments, which are still to be typed.
    pin: kept ? null : base.pin,
    env: [...base.env, ...again].toSorted((a, b) => a.index - b.index),
  };
  if (line._tag === "invalid" || hasProblems(problems)) return { _tag: "invalid", problems };
  return { _tag: "command", command: line.command };
}

/**
 * What the operator confirms before a command line runs: the program and
 * every argument, as they will run, each variable that decides which code
 * runs with its value (`settings`, {@link codeVariable}), as part of the
 * line, and the name of every other variable, never its value. `added` and
 * `removed` name the variables the command did not have before, or no
 * longer has, none for a new connector.
 */
export interface CommandConsent {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly settings: ReadonlyArray<PairInput>;
  readonly names: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly programChanged: boolean;
}

/** The confirmation for `command`, against what the connector ran before, if it has run. */
export function commandConsent(command: CommandLine, before: KnownCommand | null): CommandConsent {
  const all: ReadonlyArray<string> = command.env.map((variable) => variable.name);
  return {
    program: command.command,
    args: command.args.map(Redacted.value),
    settings: command.env.flatMap((variable) =>
      codeVariable(variable.name)
        ? [{ name: variable.name, value: Redacted.value(variable.value) }]
        : [],
    ),
    names: all.filter((name) => !codeVariable(name)),
    added: before === null ? [] : all.filter((name) => !before.names.includes(name)),
    removed: before === null ? [] : before.names.filter((name) => !all.includes(name)),
    programChanged: before !== null && before.program !== command.command,
  };
}

/** What the client knows of `connector`'s command line, for one started by command. */
export function knownCommand(
  connector: Pick<Connector, "transport" | "fields">,
): KnownCommand | null {
  return connector.transport._tag === "command"
    ? { program: connector.transport.program, names: connector.fields.map((field) => field.key) }
    : null;
}
