// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Just enough of a shell's grammar for the evals' graders and stand-in shells
 * to tell what a command would run: `echo 'gh run list'` prints text and runs
 * no `gh`, and `jq . f > /tmp/x` reads `f` and writes only `/tmp/x`.
 *
 * A command is split into simple commands at unquoted `;`, `&&`, `||`, `|`,
 * `&`, newlines, parentheses, backticks and `$(`. Each keeps its words with
 * quotes removed, and its redirections apart from them.
 */

/** One simple command: the program it runs, its arguments, and where it redirects. */
export interface SimpleCommand {
  /** Variables assigned in front of it, such as `GH_REPO=acme/docs`. */
  readonly env: ReadonlyMap<string, string>;
  /** `undefined` for a bare assignment or a line with only a redirection. */
  readonly program: string | undefined;
  readonly args: ReadonlyArray<string>;
  /** Files written by `>`, `>>` or `>|`. */
  readonly writes: ReadonlyArray<string>;
  /** Files read by `<`. */
  readonly reads: ReadonlyArray<string>;
}

interface Word {
  readonly text: string;
  /** A redirection operator such as `>`, `2>>` or `<<`, rather than a word. */
  readonly operator: boolean;
}

/** Words a command may be wrapped in that still run the command after them. */
const WRAPPERS = new Set(["env", "command", "time", "exec", "nohup"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

const toCommand = (words: ReadonlyArray<Word>): SimpleCommand => {
  const env = new Map<string, string>();
  const plain: Array<string> = [];
  const writes: Array<string> = [];
  const reads: Array<string> = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === undefined) continue;
    if (!word.operator) {
      plain.push(word.text);
      continue;
    }
    // An operator's target is the next word; it is never an argument.
    const target = words[index + 1];
    if (target === undefined || target.operator) continue;
    index++;
    if (/^\d*>[>|]?$/.test(word.text)) writes.push(target.text);
    else if (/^\d*<$/.test(word.text)) reads.push(target.text);
  }
  let start = 0;
  for (; start < plain.length; start++) {
    const word = plain[start] ?? "";
    const assignment = ASSIGNMENT.exec(word);
    if (assignment !== null) env.set(assignment[1] ?? "", assignment[2] ?? "");
    else if (!WRAPPERS.has(word)) break;
  }
  return { env, program: plain[start], args: plain.slice(start + 1), writes, reads };
};

/** The simple commands `command` runs, in order. */
export const simpleCommands = (command: string): ReadonlyArray<SimpleCommand> => {
  const commands: Array<SimpleCommand> = [];
  let words: Array<Word> = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) words.push({ text: word, operator: false });
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(toCommand(words));
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\" && /["\\$`]/.test(next)) {
        word += next;
        index++;
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      if (next !== "\n") word += next;
      inWord = inWord || next !== "\n";
      index++;
    } else if (char === "$" && next === "(") {
      endCommand();
      index++;
    } else if (";&|()`\n".includes(char)) {
      endCommand();
    } else if (char === "<" || char === ">") {
      // A number right before the operator names a descriptor: `2>/dev/null`.
      const descriptor = inWord && /^\d+$/.test(word) ? word : "";
      if (descriptor !== "") {
        word = "";
        inWord = false;
      }
      endWord();
      let operator = descriptor + char;
      while (/[<>|&]/.test(command[index + 1] ?? "") && operator.length < descriptor.length + 3) {
        operator += command[index + 1];
        index++;
      }
      words.push({ text: operator, operator: true });
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (index + 1 < command.length && command[index + 1] !== "\n") index++;
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
};
