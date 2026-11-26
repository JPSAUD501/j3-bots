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
  pinRefusal,
  type PinRefusal,
  reservedVariable,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// The forms that change a connector the operator has, as they fill them in:
// a key or token given again, and a command connector's edit. Every value the
// operator typed is redacted here, the moment it leaves the form, and the
// server checks each again.

/** A row of a list of names and values: an environment variable. */
export interface PairInput {
  readonly name: string;
  readonly value: string;
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
 * What a command connector's edit got wrong, each where the operator typed
 * it: no program (`command`), an argument too long (`args`), a package it
 * runs at no exact version (`pin`), arguments kept where a changed command
 * needs them again (`argsAgain`), and the rows of `env` the server would
 * refuse.
 */
export interface FormProblems {
  readonly command: boolean;
  readonly args: boolean;
  readonly pin: PinRefusal | null;
  readonly argsAgain: boolean;
  readonly env: ReadonlyArray<EnvProblem>;
}

const noProblems: FormProblems = {
  command: false,
  args: false,
  pin: null,
  argsAgain: false,
  env: [],
};

const hasProblems = (problems: FormProblems) =>
  problems.command ||
  problems.args ||
  problems.pin !== null ||
  problems.argsAgain ||
  problems.env.length > 0;

const [, , commandFields] = ConnectorSource.members;
const decodeArgs = Schema.decodeUnknownOption(commandFields.fields.args);
const decodeEnvName = Schema.decodeUnknownOption(EnvName);
const decodeFieldKey = Schema.decodeUnknownOption(FieldKey);
const isCommand = Schema.is(ConnectorCommand.fields.command);

/** A row the operator left blank, which the form drops rather than refuses. */
const blank = (pair: PairInput) => pair.name.trim() === "" && pair.value === "";

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
 * A command line as the operator typed it, as `connector.update` takes it, or what the server would refuse in it: a
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
 * longer has.
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

/** The confirmation for `command`, against what the connector ran before. */
export function commandConsent(command: CommandLine, before: KnownCommand): CommandConsent {
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
    added: all.filter((name) => !before.names.includes(name)),
    removed: before.names.filter((name) => !all.includes(name)),
    programChanged: before.program !== command.command,
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
