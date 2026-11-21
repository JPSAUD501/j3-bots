// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * A small shell for the evals' stand-in workspaces. It runs a command the way
 * `sh` would, against an in-memory file tree and the programs a fixture
 * supplies, and records what the command did: the files it read, wrote and
 * removed, what it could not run, and the events the fixture's programs
 * report. Graders read those records,
 * so `echo 'gh run list'` counts as nothing, and a read inside `$(…)` counts
 * as a read, however the command is spelled.
 *
 * It is a limited fixture, not a shell. It takes single and double quotes,
 * backslashes, `$NAME` and `${NAME}`, `$(…)` and backticks (inside double
 * quotes too), `;`, `&&`, `||`, `|`, `&` (run in order), newlines, comments,
 * the redirections `<`, `>`, `>>`, `2>`, `2>&1` and `&>`, `set -e`, here-documents
 * (their body taken literally) and here-strings, and the builtins below. A
 * word is never split or globbed. Anything else (a loop, `if`, a subshell, a
 * program the workspace lacks) fails with an error that says so, so a model
 * learns what to use instead of reading output no real shell would give.
 */

/** What the shell itself saw a command do, besides what its programs report. */
export type ShellEvent =
  /** A file in the workspace was read, by its absolute path. */
  | { readonly type: "file-read"; readonly path: string }
  /** A file was written, with its content after the write. */
  | { readonly type: "file-write"; readonly path: string; readonly content: string }
  /** A file was removed, by `rm` or as the source of `mv`. */
  | { readonly type: "file-delete"; readonly path: string }
  /**
   * Part of the command did not run: a program the workspace lacks, or syntax
   * this shell does not take. What it meant to do is unknown, so no grader can
   * count it as harmless.
   */
  | { readonly type: "unavailable"; readonly what: string };

/** What a program prints and how it exits. */
export interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

interface ProgramContext<E> {
  readonly stdin: string;
  /** Variables assigned in front of the command, such as `GH_REPO=acme/docs`, over the shell's own. */
  readonly env: ReadonlyMap<string, string>;
  /** Reports what the program did, for the graders. */
  readonly record: (event: E) => void;
}

/** A program a fixture supplies, such as a stand-in `gh`. */
export type Program<E> = (args: ReadonlyArray<string>, context: ProgramContext<E>) => Outcome;

/** What one command printed, its output and errors together, and what it did. */
export interface ShellRun<E> {
  readonly output: string;
  readonly events: ReadonlyArray<E | ShellEvent>;
}

export const ok = (stdout: string): Outcome => ({ stdout, stderr: "", status: 0 });
export const fail = (stderr: string, status = 1): Outcome => ({
  stdout: "",
  stderr: stderr === "" || stderr.endsWith("\n") ? stderr : `${stderr}\n`,
  status,
});

/** The workspace folder a command starts in. */
export const HOME = "/workspace";

// The syntax tree.

type Part =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "variable"; readonly name: string }
  | { readonly type: "substitution"; readonly script: Script };
type Word = ReadonlyArray<Part>;

/** A here-document's body, filled in once the line that opened it ends. */
interface HereDocument {
  body: string;
}

type Redirect =
  | {
      readonly type: "file";
      readonly fd: 0 | 1 | 2 | "both";
      readonly mode: "read" | "write" | "append";
      readonly target: Word;
    }
  | { readonly type: "duplicate"; readonly fd: 1 | 2; readonly to: 1 | 2 }
  | { readonly type: "here-string"; readonly text: Word }
  | { readonly type: "here-document"; readonly document: HereDocument };

interface SimpleCommand {
  readonly words: ReadonlyArray<Word>;
  readonly redirects: ReadonlyArray<Redirect>;
}

interface Step {
  readonly pipeline: ReadonlyArray<SimpleCommand>;
  /** How it follows the step before: always, only after a success, or only after a failure. */
  readonly when: "always" | "and" | "or";
}
type Script = ReadonlyArray<Step>;

/** Syntax this shell does not take. */
class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
}) {}

/** Words that open a compound command, which this shell does not run. */
const COMPOUND = new Set(["if", "for", "while", "until", "case", "select", "function", "{"]);

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const BLANK = /[ \t]/;
const WORD_END = /[\s;&|<>]/;

/** A command's syntax tree, or a {@link ParseError} for what this shell does not take. */
const parse = (source: string): Script => {
  let pos = 0;
  const pending: Array<{ readonly delimiter: string; readonly document: HereDocument }> = [];

  const peek = (offset = 0) => source[pos + offset] ?? "";
  const skipBlanks = () => {
    while (BLANK.test(peek()) || (peek() === "\\" && peek(1) === "\n")) {
      pos += peek() === "\\" ? 2 : 1;
    }
  };

  const readHereDocuments = () => {
    for (const { delimiter, document } of pending.splice(0)) {
      for (;;) {
        if (pos >= source.length)
          throw new ParseError({ message: `here-document not ended by ${delimiter}` });
        const end = source.indexOf("\n", pos);
        const line = source.slice(pos, end === -1 ? source.length : end);
        pos = end === -1 ? source.length : end + 1;
        if (line === delimiter) break;
        document.body += `${line}\n`;
      }
    }
  };

  const parseDollar = (): Part => {
    // At `$`.
    if (peek(1) === "(") {
      if (peek(2) === "(")
        throw new ParseError({ message: "arithmetic expansion is not supported" });
      pos += 2;
      return { type: "substitution", script: parseScript(")") };
    }
    if (peek(1) === "{") {
      const end = source.indexOf("}", pos);
      const name = source.slice(pos + 2, end);
      if (end === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new ParseError({ message: "only ${NAME} is supported" });
      }
      pos = end + 1;
      return { type: "variable", name };
    }
    NAME.lastIndex = pos + 1;
    const name = NAME.exec(source)?.[0];
    if (name !== undefined) {
      pos += 1 + name.length;
      return { type: "variable", name };
    }
    pos++;
    return { type: "text", text: "$" };
  };

  const parseDoubleQuoted = (): ReadonlyArray<Part> => {
    pos++;
    const parts: Array<Part> = [];
    let text = "";
    const flush = () => {
      if (text !== "") parts.push({ type: "text", text });
      text = "";
    };
    for (;;) {
      if (pos >= source.length) throw new ParseError({ message: "unterminated double quote" });
      const char = peek();
      if (char === '"') {
        pos++;
        break;
      }
      if (char === "\\" && /["\\$`\n]/.test(peek(1))) {
        if (peek(1) !== "\n") text += peek(1);
        pos += 2;
      } else if (char === "$") {
        flush();
        parts.push(parseDollar());
      } else if (char === "`") {
        flush();
        pos++;
        parts.push({ type: "substitution", script: parseScript("`") });
      } else {
        text += char;
        pos++;
      }
    }
    flush();
    return parts;
  };

  /** One word, up to a blank or an operator; `undefined` when none starts here. */
  const parseWord = (closer: string | null): Word | undefined => {
    const parts: Array<Part> = [];
    let started = false;
    let text = "";
    const flush = () => {
      if (text !== "") parts.push({ type: "text", text });
      text = "";
    };
    for (;;) {
      const char = peek();
      if (char === "" || WORD_END.test(char)) break;
      if (char === ")" || char === "(") {
        if (char === ")" && closer === ")") break;
        throw new ParseError({ message: "subshells and groups are not supported" });
      }
      if (char === "`" && closer === "`") break;
      started = true;
      if (char === "'") {
        const end = source.indexOf("'", pos + 1);
        if (end === -1) throw new ParseError({ message: "unterminated single quote" });
        text += source.slice(pos + 1, end);
        pos = end + 1;
      } else if (char === '"') {
        flush();
        parts.push(...parseDoubleQuoted());
      } else if (char === "\\") {
        if (peek(1) !== "\n") text += peek(1);
        pos += 2;
      } else if (char === "$") {
        flush();
        parts.push(parseDollar());
      } else if (char === "`") {
        flush();
        pos++;
        parts.push({ type: "substitution", script: parseScript("`") });
      } else {
        text += char;
        pos++;
      }
    }
    flush();
    // `''` is still a word: one with no parts.
    return started ? parts : undefined;
  };

  /** The text of a word that must be literal: a here-document's delimiter, or a descriptor. */
  const literal = (word: Word): string =>
    word
      .map((part) => {
        if (part.type !== "text") throw new ParseError({ message: "expected a literal word" });
        return part.text;
      })
      .join("");

  const parseRedirect = (closer: string | null): Redirect => {
    let fd: 0 | 1 | 2 | "both" | undefined;
    if (/\d/.test(peek())) {
      const digit = peek();
      if (digit !== "0" && digit !== "1" && digit !== "2") {
        throw new ParseError({ message: `file descriptor ${digit} is not supported` });
      }
      fd = digit === "0" ? 0 : digit === "1" ? 1 : 2;
      pos++;
    } else if (peek() === "&" && peek(1) === ">") {
      fd = "both";
      pos++;
    }
    const operator = peek();
    pos++;
    if (operator === "<") {
      if (peek() === "<" && peek(1) === "<") {
        pos += 2;
        skipBlanks();
        const text = parseWord(closer);
        if (text === undefined) throw new ParseError({ message: "here-string without a word" });
        return { type: "here-string", text };
      }
      if (peek() === "<") {
        pos++;
        const stripTabs = peek() === "-";
        if (stripTabs) throw new ParseError({ message: "<<- is not supported" });
        skipBlanks();
        const word = parseWord(closer);
        if (word === undefined)
          throw new ParseError({ message: "here-document without a delimiter" });
        const document: HereDocument = { body: "" };
        pending.push({ delimiter: literal(word), document });
        return { type: "here-document", document };
      }
      skipBlanks();
      const target = parseWord(closer);
      if (target === undefined) throw new ParseError({ message: "< without a file" });
      return { type: "file", fd: fd === undefined || fd === "both" ? 0 : fd, mode: "read", target };
    }
    // `>`, `>>`, `>|`, `>&N`.
    let mode: "write" | "append" = "write";
    if (peek() === ">") {
      mode = "append";
      pos++;
    } else if (peek() === "|") pos++;
    if (peek() === "&") {
      pos++;
      const to = peek();
      if ((to !== "1" && to !== "2") || fd === "both" || fd === 0) {
        throw new ParseError({ message: "only 2>&1 and 1>&2 are supported" });
      }
      pos++;
      return { type: "duplicate", fd: fd ?? 1, to: to === "1" ? 1 : 2 };
    }
    skipBlanks();
    const target = parseWord(closer);
    if (target === undefined) throw new ParseError({ message: "> without a file" });
    return { type: "file", fd: fd === undefined || fd === 0 ? 1 : fd, mode, target };
  };

  const parseCommand = (closer: string | null): SimpleCommand => {
    const words: Array<Word> = [];
    const redirects: Array<Redirect> = [];
    for (;;) {
      skipBlanks();
      const char = peek();
      if (char === "" || char === "\n" || char === ";" || char === "|") break;
      if (char === "&" && peek(1) !== ">") break;
      if (char === closer) break;
      if (char === "#") {
        while (pos < source.length && peek() !== "\n") pos++;
        break;
      }
      if (
        /[<>]/.test(char) ||
        /^[012][<>]$/.test(char + peek(1)) ||
        (char === "&" && peek(1) === ">")
      ) {
        redirects.push(parseRedirect(closer));
        continue;
      }
      const word = parseWord(closer);
      if (word === undefined) break;
      const [part] = word;
      if (
        words.length === 0 &&
        word.length === 1 &&
        part?.type === "text" &&
        COMPOUND.has(part.text)
      ) {
        throw new ParseError({
          message: `\`${part.text}\` and other compound commands are not supported`,
        });
      }
      words.push(word);
    }
    if (words.length === 0 && redirects.length === 0)
      throw new ParseError({ message: "empty command" });
    return { words, redirects };
  };

  /** Steps up to the end, or up to `closer` (`)` or a backtick), which it consumes. */
  const parseScript = (closer: string | null): Script => {
    const steps: Array<Step> = [];
    let when: Step["when"] = "always";
    for (;;) {
      skipBlanks();
      const char = peek();
      if (char === "") {
        if (closer !== null) throw new ParseError({ message: `missing ${closer}` });
        if (pending.length > 0) throw new ParseError({ message: "here-document without a body" });
        return steps;
      }
      if (char === closer) {
        pos++;
        return steps;
      }
      if (char === "\n") {
        pos++;
        readHereDocuments();
        continue;
      }
      if (char === "#") {
        while (pos < source.length && peek() !== "\n") pos++;
        continue;
      }
      if (char === ";" || (char === "&" && peek(1) !== "&")) {
        pos++;
        continue;
      }
      if ((char === "&" || char === "|") && peek(1) === char) {
        pos += 2;
        when = char === "&" ? "and" : "or";
        continue;
      }
      const pipeline = [parseCommand(closer)];
      for (;;) {
        skipBlanks();
        if (peek() !== "|" || peek(1) === "|") break;
        pos++;
        while (/\s/.test(peek())) pos++;
        pipeline.push(parseCommand(closer));
      }
      steps.push({ pipeline, when });
      when = "always";
    }
  };

  return parseScript(null);
};

// Running it.

const normalize = (path: string): string => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** Where a descriptor's output goes. */
type Sink =
  | { readonly type: "stdout" }
  | { readonly type: "stderr" }
  | { readonly type: "file"; readonly path: string };

const parent = (path: string): string => normalize(`${path}/..`);
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const BUILTINS = [
  "cat",
  "cd",
  "cp",
  "echo",
  "export",
  "set",
  "false",
  "head",
  "ls",
  "mkdir",
  "mv",
  "printf",
  "pwd",
  "rm",
  "tail",
  "tee",
  "test",
  "true",
  "[",
] as const;
type Builtin = (typeof BUILTINS)[number];
const isBuiltin = (name: string): name is Builtin =>
  (BUILTINS as ReadonlyArray<string>).includes(name);

/** `\n`, `\t` and `\\` in `echo -e` and `printf`. */
const unescape = (text: string): string =>
  text.replace(/\\([nt\\])/g, (_, char: string) =>
    char === "n" ? "\n" : char === "t" ? "\t" : "\\",
  );

const printf = (format: string, args: ReadonlyArray<string>): string => {
  let output = "";
  let index = 0;
  do {
    output += unescape(format).replace(/%([%sd])/g, (_, spec: string) => {
      if (spec === "%") return "%";
      const arg = args[index++] ?? "";
      return spec === "d" ? String(Number.parseInt(arg, 10) || 0) : arg;
    });
  } while (index < args.length && /%[sd]/.test(format));
  return output;
};

/** The line count of `head -n 3`, `head -3` or `head -n3`; 10 by default. */
const lineCount = (
  args: ReadonlyArray<string>,
): { count: number; files: ReadonlyArray<string> } | string => {
  let count = 10;
  const files: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const value =
      arg === "-n"
        ? args[++index]
        : /^-n\d+$/.test(arg)
          ? arg.slice(2)
          : /^-\d+$/.test(arg)
            ? arg.slice(1)
            : undefined;
    if (value !== undefined) {
      if (!/^\d+$/.test(value)) return `invalid number of lines: ${value}`;
      count = Number(value);
    } else if (arg.startsWith("-") && arg !== "-") return `option ${arg} is not supported`;
    else files.push(arg);
  }
  return { count, files };
};

/**
 * A workspace: its files, which persist from one command to the next, and the
 * programs a fixture supplies besides the builtins.
 */
export class Workspace<E> {
  readonly #files: Map<string, string>;
  readonly #directories: Set<string>;
  readonly #programs: ReadonlyMap<string, Program<E>>;

  constructor(options: {
    readonly programs: ReadonlyMap<string, Program<E>>;
    /** Files by path, relative to {@link HOME} or absolute. */
    readonly files?: ReadonlyMap<string, string>;
  }) {
    this.#programs = options.programs;
    this.#files = new Map();
    this.#directories = new Set(["/", HOME, `${HOME}/files`, "/tmp", "/dev"]);
    for (const [path, content] of options.files ?? []) {
      const absolute = normalize(path.startsWith("/") ? path : `${HOME}/${path}`);
      this.#files.set(absolute, content);
      for (let dir = parent(absolute); dir !== "/"; dir = parent(dir)) this.#directories.add(dir);
    }
  }

  /** The names a command can run, for an error that lists them. */
  get commands(): ReadonlyArray<string> {
    return [...BUILTINS.filter((name) => name !== "["), ...this.#programs.keys()].toSorted();
  }

  /** The content of a file, by its path relative to {@link HOME} or absolute. */
  file(path: string): string | undefined {
    return this.#files.get(normalize(path.startsWith("/") ? path : `${HOME}/${path}`));
  }

  /** Runs one command in a fresh shell in {@link HOME}. */
  run(command: string): ShellRun<E> {
    const events: Array<E | ShellEvent> = [];
    let script: Script;
    try {
      script = parse(command);
    } catch (error) {
      if (!Schema.is(ParseError)(error)) throw error;
      events.push({ type: "unavailable", what: error.message });
      return { output: `sh: ${error.message} in this workspace\n`, events };
    }
    const shell = new Run(this.#files, this.#directories, this.#programs, this.commands, events);
    const outcome = shell.script(script, "");
    return { output: outcome.stdout + outcome.stderr, events };
  }
}

/** One command's shell: its folder, its variables, and what it records. */
class Run<E> {
  #cwd = HOME;
  /** `set -e`: stop at the first step that fails outside an `&&` or `||` list. */
  #exitOnError = false;
  #substitutionErrors = "";
  readonly #variables = new Map<string, string>();
  readonly #files: Map<string, string>;
  readonly #directories: Set<string>;
  readonly #programs: ReadonlyMap<string, Program<E>>;
  readonly #commands: ReadonlyArray<string>;
  readonly #events: Array<E | ShellEvent>;

  constructor(
    files: Map<string, string>,
    directories: Set<string>,
    programs: ReadonlyMap<string, Program<E>>,
    commands: ReadonlyArray<string>,
    events: Array<E | ShellEvent>,
  ) {
    this.#files = files;
    this.#directories = directories;
    this.#programs = programs;
    this.#commands = commands;
    this.#events = events;
  }

  #resolve(path: string): string {
    const expanded = path === "~" ? HOME : path.startsWith("~/") ? `${HOME}${path.slice(1)}` : path;
    return normalize(expanded.startsWith("/") ? expanded : `${this.#cwd}/${expanded}`);
  }

  #read(path: string): string | undefined {
    const absolute = this.#resolve(path);
    if (absolute === "/dev/null") return "";
    const content = this.#files.get(absolute);
    if (content !== undefined) this.#events.push({ type: "file-read", path: absolute });
    return content;
  }

  /** Writes a file; an error message when its folder does not exist. */
  #write(path: string, content: string, append: boolean): string | undefined {
    const absolute = this.#resolve(path);
    if (absolute === "/dev/null") return undefined;
    if (this.#directories.has(absolute)) return `${path}: Is a directory`;
    if (!this.#directories.has(parent(absolute))) return `${path}: No such file or directory`;
    const next = (append ? (this.#files.get(absolute) ?? "") : "") + content;
    this.#files.set(absolute, next);
    this.#events.push({ type: "file-write", path: absolute, content: next });
    return undefined;
  }

  /** Removes a file by its absolute path; false when there was none. */
  #delete(absolute: string): boolean {
    if (!this.#files.delete(absolute)) return false;
    this.#events.push({ type: "file-delete", path: absolute });
    return true;
  }

  script(script: Script, stdin: string): Outcome {
    let stdout = "";
    let stderr = "";
    let status = 0;
    for (const [index, step] of script.entries()) {
      if ((step.when === "and" && status !== 0) || (step.when === "or" && status === 0)) continue;
      let input = stdin;
      for (const command of step.pipeline) {
        const outcome = this.#command(command, input);
        stderr += outcome.stderr;
        input = outcome.stdout;
        status = outcome.status;
      }
      stdout += input;
      const next = script[index + 1];
      if (this.#exitOnError && status !== 0 && next?.when !== "and" && next?.when !== "or") break;
    }
    return { stdout, stderr, status };
  }

  #expand(word: Word): string {
    return word
      .map((part) => {
        switch (part.type) {
          case "text":
            return part.text;
          case "variable":
            return this.#variables.get(part.name) ?? "";
          case "substitution": {
            const outcome = this.script(part.script, "");
            this.#substitutionErrors += outcome.stderr;
            return outcome.stdout.replace(/\n+$/, "");
          }
        }
      })
      .join("");
  }

  #command(command: SimpleCommand, pipeInput: string): Outcome {
    const words = command.words.map((word) => this.#expand(word));
    // What a substitution printed to stderr reaches the output, as it would a terminal.
    const substitutionErrors = this.#substitutionErrors;
    this.#substitutionErrors = "";
    const env = new Map(this.#variables);
    let start = 0;
    for (; start < words.length; start++) {
      const assignment = ASSIGNMENT.exec(words[start] ?? "");
      if (assignment === null) break;
      env.set(assignment[1] ?? "", assignment[2] ?? "");
    }
    if (start === words.length) {
      // A bare assignment sets the shell's variables.
      for (const [name, value] of env) this.#variables.set(name, value);
    }
    if (words[start] === "env") start++;

    let stdin = pipeInput;
    const sinks: { 1: Sink; 2: Sink } = { 1: { type: "stdout" }, 2: { type: "stderr" } };
    for (const redirect of command.redirects) {
      switch (redirect.type) {
        case "here-document":
          stdin = redirect.document.body;
          break;
        case "here-string":
          stdin = `${this.#expand(redirect.text)}\n`;
          break;
        case "duplicate":
          sinks[redirect.fd] = sinks[redirect.to];
          break;
        case "file": {
          const path = this.#expand(redirect.target);
          if (redirect.mode === "read") {
            const content = this.#read(path);
            if (content === undefined) return fail(`sh: ${path}: No such file or directory`);
            stdin = content;
            break;
          }
          // Open the file, truncating it unless appending, as `sh` does before the program runs.
          const error = this.#write(path, "", redirect.mode === "append");
          if (error !== undefined) return fail(`sh: ${error}`);
          const sink: Sink = { type: "file", path };
          if (redirect.fd === 1 || redirect.fd === "both") sinks[1] = sink;
          if (redirect.fd === 2 || redirect.fd === "both") sinks[2] = sink;
        }
      }
    }

    const name = words[start];
    const args = words.slice(start + 1);
    const outcome =
      name === undefined
        ? ok("")
        : isBuiltin(name)
          ? this.#builtin(name, args, stdin)
          : this.#program(name, args, stdin, env);

    let stdout = "";
    let stderr = substitutionErrors;
    for (const [fd, text] of [
      [1, outcome.stdout],
      [2, outcome.stderr],
    ] as const) {
      const sink = sinks[fd];
      if (sink.type === "stdout") stdout += text;
      else if (sink.type === "stderr") stderr += text;
      else if (text !== "") this.#write(sink.path, text, true);
    }
    return { stdout, stderr, status: outcome.status };
  }

  #program(
    name: string,
    args: ReadonlyArray<string>,
    stdin: string,
    env: ReadonlyMap<string, string>,
  ): Outcome {
    const program = this.#programs.get(name);
    if (program === undefined) {
      this.#events.push({ type: "unavailable", what: `command ${name}` });
      return fail(
        `sh: ${name}: command not found. This workspace has: ${this.#commands.join(", ")}.`,
        127,
      );
    }
    return program(args, { stdin, env, record: (event) => this.#events.push(event) });
  }

  #builtin(name: Builtin, args: ReadonlyArray<string>, stdin: string): Outcome {
    switch (name) {
      case "true":
        return ok("");
      case "false":
        return fail("", 1);
      case "pwd":
        return ok(`${this.#cwd}\n`);
      case "set":
        for (const arg of args) {
          if (/^-[euo]+$/.test(arg)) this.#exitOnError ||= arg.includes("e");
          else if (arg !== "-o" && arg !== "pipefail")
            return fail(`set: ${arg} is not supported`, 2);
        }
        return ok("");
      case "export":
        for (const arg of args) {
          const assignment = ASSIGNMENT.exec(arg);
          if (assignment !== null) this.#variables.set(assignment[1] ?? "", assignment[2] ?? "");
        }
        return ok("");
      case "echo": {
        let rest = args;
        let newline = true;
        let escapes = false;
        while (/^-[ne]+$/.test(rest[0] ?? "")) {
          newline &&= !(rest[0] ?? "").includes("n");
          escapes ||= (rest[0] ?? "").includes("e");
          rest = rest.slice(1);
        }
        const text = rest.join(" ");
        return ok((escapes ? unescape(text) : text) + (newline ? "\n" : ""));
      }
      case "printf":
        return args[0] === undefined
          ? fail("printf: missing format")
          : ok(printf(args[0], args.slice(1)));
      case "cd": {
        const target = this.#resolve(args[0] ?? HOME);
        if (!this.#directories.has(target))
          return fail(`cd: ${args[0] ?? ""}: No such file or directory`);
        this.#cwd = target;
        return ok("");
      }
      case "mkdir": {
        const recursive = args.includes("-p");
        for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
          const path = this.#resolve(arg);
          if (this.#directories.has(path) && !recursive) return fail(`mkdir: ${arg}: File exists`);
          if (!recursive && !this.#directories.has(parent(path))) {
            return fail(`mkdir: ${arg}: No such file or directory`);
          }
          for (let dir = path; dir !== "/"; dir = parent(dir)) this.#directories.add(dir);
        }
        return ok("");
      }
      case "ls": {
        const paths = args.filter((arg) => !arg.startsWith("-"));
        const lines: Array<string> = [];
        for (const arg of paths.length === 0 ? ["."] : paths) {
          const path = this.#resolve(arg);
          if (this.#files.has(path)) {
            lines.push(arg);
            continue;
          }
          if (!this.#directories.has(path)) return fail(`ls: ${arg}: No such file or directory`);
          const prefix = path === "/" ? "/" : `${path}/`;
          const entries = new Set(
            [...this.#files.keys(), ...this.#directories]
              .filter((entry) => entry.startsWith(prefix) && entry !== path)
              .map((entry) => entry.slice(prefix.length).split("/")[0] ?? ""),
          );
          lines.push(...[...entries].toSorted());
        }
        return ok(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
      }
      case "cat": {
        let output = "";
        for (const arg of args.length === 0 ? ["-"] : args) {
          if (arg === "-") {
            output += stdin;
            continue;
          }
          const content = this.#read(arg);
          if (content === undefined) {
            return { ...fail(`cat: ${arg}: No such file or directory`), stdout: output };
          }
          output += content;
        }
        return ok(output);
      }
      case "head":
      case "tail": {
        const parsed = lineCount(args);
        if (typeof parsed === "string") return fail(`${name}: ${parsed}`);
        let text = stdin;
        if (parsed.files.length > 0) {
          const [file] = parsed.files;
          const content = file === undefined ? undefined : this.#read(file);
          if (content === undefined)
            return fail(`${name}: ${file ?? ""}: No such file or directory`);
          text = content;
        }
        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const kept =
          name === "head"
            ? lines.slice(0, parsed.count)
            : lines.slice(-parsed.count || lines.length);
        return ok(kept.length === 0 ? "" : `${kept.join("\n")}\n`);
      }
      case "tee": {
        const append = args.includes("-a");
        for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
          const error = this.#write(arg, stdin, append);
          if (error !== undefined) return fail(`tee: ${error}`);
        }
        return ok(stdin);
      }
      case "cp":
      case "mv": {
        const paths = args.filter((arg) => !arg.startsWith("-"));
        const [source, destination] = paths;
        if (source === undefined || destination === undefined || paths.length > 2) {
          return fail(`${name}: expected a source and a destination`);
        }
        const from = this.#resolve(source);
        const content = this.#files.get(from);
        if (content === undefined) return fail(`${name}: ${source}: No such file or directory`);
        const to = this.#directories.has(this.#resolve(destination))
          ? `${destination}/${basename(from)}`
          : destination;
        const error = this.#write(to, content, false);
        if (error !== undefined) return fail(`${name}: ${error}`);
        if (name === "mv" && from !== this.#resolve(to)) this.#delete(from);
        return ok("");
      }
      case "rm": {
        const force = args.some((arg) => /^-\w*f/.test(arg));
        for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
          if (!this.#delete(this.#resolve(arg)) && !force) {
            return fail(`rm: ${arg}: No such file or directory`);
          }
        }
        return ok("");
      }
      case "test":
      case "[": {
        let operands = args;
        if (name === "[") {
          if (operands.at(-1) !== "]") return fail("[: missing ]", 2);
          operands = operands.slice(0, -1);
        }
        const negate = operands[0] === "!";
        if (negate) operands = operands.slice(1);
        const result = this.#test(operands);
        if (result === undefined) return fail(`${name}: this test is not supported`, 2);
        return result !== negate ? ok("") : fail("", 1);
      }
    }
  }

  #test(operands: ReadonlyArray<string>): boolean | undefined {
    const [first, second, third] = operands;
    if (operands.length === 1) return (first ?? "") !== "";
    if (operands.length === 2 && first !== undefined && second !== undefined) {
      const path = this.#resolve(second);
      switch (first) {
        case "-e":
          return this.#files.has(path) || this.#directories.has(path);
        case "-f":
          return this.#files.has(path);
        case "-s":
          return (this.#files.get(path) ?? "") !== "";
        case "-d":
          return this.#directories.has(path);
        case "-n":
          return second !== "";
        case "-z":
          return second === "";
      }
      return undefined;
    }
    if (operands.length === 3 && (second === "=" || second === "==")) return first === third;
    if (operands.length === 3 && second === "!=") return first !== third;
    return undefined;
  }
}
