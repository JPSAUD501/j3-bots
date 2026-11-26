// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CommandLine, type ConnectorField, FieldKey } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import {
  type ArgumentsDraft,
  commandConsent,
  type CommandEdit,
  commandEdit,
  type FormProblems,
  type KnownCommand,
  refillValues,
  withoutSecrets,
} from "./connectorForm.ts";

const plain = (value: Redacted.Redacted<string>) => Redacted.value(value);

const token = FieldKey.make("token");
const team = FieldKey.make("team");
const fields: ReadonlyArray<ConnectorField> = [
  {
    key: token,
    label: "Token",
    description: null,
    secret: true,
    required: true,
    placeholder: null,
    choices: [],
  },
  {
    key: team,
    label: "Team",
    description: null,
    secret: false,
    required: false,
    placeholder: null,
    choices: [],
  },
];

type Env = ReadonlyArray<{ name: string; value: string }>;

/** A new command line typed whole in an edit of `known`, as the server would take it. */
const newLine = (known: KnownCommand, command: string, args: string, env: Env): CommandEdit =>
  commandEdit(known, { command, args: { _tag: "typed", text: args }, env });
const sent = (edit: CommandEdit): CommandLine => {
  if (edit._tag !== "command") throw new Error(`Not a command line: ${JSON.stringify(edit)}`);
  return edit.command;
};
const refused = (edit: CommandEdit): FormProblems => {
  if (edit._tag !== "invalid") throw new Error(`Accepted: ${edit._tag}`);
  return edit.problems;
};
const files: KnownCommand = { program: "npx", names: [] };

describe("a connector's fields given again", () => {
  it("sends only those given, so one field of several takes a new value alone", () => {
    const given = refillValues(
      fields,
      new Map([
        [token, "new-key"],
        [team, ""],
      ]),
    );
    if (given._tag !== "ready") throw new Error("Refused");
    expect(given.values.map((value) => [value.key, plain(value.value)])).toEqual([
      [token, "new-key"],
    ]);
  });

  it("asks for something when nothing is given", () => {
    expect(refillValues(fields, new Map([[token, ""]]))).toEqual({
      _tag: "invalid",
      missing: [token, team],
    });
  });
});

describe("a form the server took", () => {
  it("keeps what its plain fields hold and none of its secret ones", () => {
    const kept = withoutSecrets(
      fields,
      new Map([
        [token, "key"],
        [team, "core"],
      ]),
    );
    expect([...kept]).toEqual([[team, "core"]]);
  });
});

describe("a command line typed in an edit", () => {
  it("takes one argument a line, blank lines dropped, and its environment", () => {
    const line = sent(
      newLine(files, "npx", "-y\n\n  @scope/server@1.2.3  \n/home/me", [
        { name: "API_KEY", value: "k" },
      ]),
    );
    // An argument can carry a key, so each leaves the form redacted.
    expect(line.args.map(plain)).toEqual(["-y", "@scope/server@1.2.3", "/home/me"]);
    expect(line.env.map((variable) => [variable.name, plain(variable.value)])).toEqual([
      ["API_KEY", "k"],
    ]);
  });

  it("asks for a command, and refuses a variable name a shell does not allow", () => {
    const problems = refused(newLine(files, "", "", [{ name: "1KEY", value: "v" }]));
    expect([problems.command, problems.env]).toEqual([true, [{ index: 0, reason: "invalid" }]]);
  });

  it("says before the server does that a package runs at no exact version", () => {
    const line = (args: string, env: Env = []) => newLine(files, "npx", args, env);
    expect(refused(line("-y\n@scope/server")).pin).toBe("floating");
    expect(refused(line("@scope/server@latest")).pin).toBe("floating");
    expect(refused(line("-c\nserver")).pin).toBe("shell");
    // A launcher setting can choose another package, whatever the arguments say.
    expect(
      refused(line("@scope/server@1.2.3", [{ name: "npm_config_registry", value: "x" }])).pin,
    ).toBe("unclear");
    expect(line("@scope/server@1.2.3")._tag).toBe("command");
    // A program no launcher reads runs as it is given.
    expect(newLine(files, "/opt/server", "--serve", [])._tag).toBe("command");
  });

  it("refuses a variable the server reads to start the program, and one named twice in any case", () => {
    const problems = refused(
      newLine(files, "node", "server.js", [
        { name: "Path", value: "/tmp" },
        { name: "API_KEY", value: "a" },
        { name: "api_key", value: "b" },
      ]),
    );
    expect(problems.env).toEqual([
      { index: 0, reason: "reserved" },
      { index: 2, reason: "twice" },
    ]);
  });

  it("refuses a secret as the value of a variable that decides which code runs, and takes it elsewhere", () => {
    const problems = refused(
      newLine(files, "python", "server.py", [
        { name: "API_KEY", value: "${secret:files-key}" },
        { name: "PythonPath", value: "/srv/lib:${secret:lib-path}" },
      ]),
    );
    expect(problems.env).toEqual([{ index: 1, reason: "code-secret" }]);
  });

  it("refuses an argument longer than a command line takes", () => {
    expect(refused(newLine(files, "npx", "x".repeat(4_001), [])).args).toBe(true);
  });
});

describe("an edit of a connector started by command", () => {
  const known = { program: "npx", names: ["API_KEY", "TEAM"] };
  const kept: ArgumentsDraft = { _tag: "kept" };
  const typed = (text: string): ArgumentsDraft => ({ _tag: "typed", text });
  const edit = (command: string, args: ArgumentsDraft, env: Env): CommandEdit =>
    commandEdit(known, { command, args, env });
  const sameNames = [
    { name: "TEAM", value: "" },
    { name: "API_KEY", value: "" },
  ];

  it("sends new values alone, with no confirmation, while the command line stays", () => {
    expect(edit("npx", kept, sameNames)).toEqual({ _tag: "unchanged" });
    const values = edit("npx", kept, [
      { name: "API_KEY", value: "new" },
      { name: "TEAM", value: "" },
    ]);
    if (values._tag !== "values") throw new Error(values._tag);
    // A value left empty keeps its own on the server.
    expect(values.values.map((value) => [value.key, plain(value.value)])).toEqual([
      ["API_KEY", "new"],
    ]);
  });

  it("asks again when a variable's name changes, or one is added or removed", () => {
    const line = (env: Env) => edit("npx", typed("@scope/server@1.2.3"), env);
    expect(
      line([
        { name: "API_TOKEN", value: "a" },
        { name: "TEAM", value: "t" },
      ])._tag,
    ).toBe("command");
    expect(line([{ name: "API_KEY", value: "a" }])._tag).toBe("command");
    expect(
      line([
        { name: "API_KEY", value: "a" },
        { name: "TEAM", value: "t" },
        { name: "REGION", value: "r" },
      ])._tag,
    ).toBe("command");
  });

  it("asks again when the program or the arguments change", () => {
    const full = [
      { name: "API_KEY", value: "a" },
      { name: "TEAM", value: "t" },
    ];
    expect(edit("uvx", typed("server==1.0.0"), full)._tag).toBe("command");
    expect(edit("npx", typed("@scope/server@1.2.4"), full)._tag).toBe("command");
  });

  it("asks for the arguments and each value again, since a new command line is sent whole", () => {
    const refused = edit("npx", kept, [
      { name: "API_TOKEN", value: "" },
      { name: "TEAM", value: "" },
    ]);
    if (refused._tag !== "invalid") throw new Error(refused._tag);
    expect(refused.problems.argsAgain).toBe(true);
    // Not yet a package at no version: the arguments that name it are still to come.
    expect(refused.problems.pin).toBeNull();
    // None keeps a value the client never saw, a renamed one included.
    expect(refused.problems.env).toEqual([
      { index: 0, reason: "value-again" },
      { index: 1, reason: "value-again" },
    ]);
  });

  it("sends the whole command line for a new value of a variable that decides which code runs", () => {
    const withOptions = commandEdit(
      { program: "npx", names: ["API_KEY", "NODE_OPTIONS"] },
      {
        command: "npx",
        args: kept,
        env: [
          { name: "API_KEY", value: "" },
          { name: "NODE_OPTIONS", value: "--require=./hook.js" },
        ],
      },
    );
    if (withOptions._tag !== "invalid") throw new Error(withOptions._tag);
    // The value is part of the line, which the operator confirms whole.
    expect(withOptions.problems.argsAgain).toBe(true);
    expect(withOptions.problems.env).toEqual([{ index: 0, reason: "value-again" }]);
  });

  it("refuses a changed command at no exact version", () => {
    const refused = edit("npx", typed("@scope/server"), [
      { name: "API_KEY", value: "a" },
      { name: "TEAM", value: "t" },
    ]);
    if (refused._tag !== "invalid") throw new Error(refused._tag);
    expect(refused.problems.pin).toBe("floating");
  });
});

describe("the confirmation of a command line", () => {
  const line = sent(
    newLine(files, "npx", "-y\n@scope/server@1.2.3", [
      { name: "API_KEY", value: "very-secret-value" },
      { name: "REGION", value: "eu" },
    ]),
  );

  it("shows the whole command line and every variable's name, never a value", () => {
    const consent = commandConsent(line, { program: "npx", names: ["API_KEY", "REGION"] });
    expect([consent.program, ...consent.args]).toEqual(["npx", "-y", "@scope/server@1.2.3"]);
    expect(consent.names).toEqual(["API_KEY", "REGION"]);
    expect(JSON.stringify(consent)).not.toContain("very-secret-value");
    expect([consent.added, consent.removed, consent.programChanged]).toEqual([[], [], false]);
  });

  it("shows a variable that decides which code runs with its value, as part of the line", () => {
    const withOptions = sent(
      newLine(files, "npx", "-y\n@scope/server@1.2.3", [
        { name: "API_KEY", value: "very-secret-value" },
        { name: "node_options", value: "--require=./hook.js" },
      ]),
    );
    const consent = commandConsent(withOptions, { program: "npx", names: ["API_KEY"] });
    expect(consent.settings).toEqual([{ name: "node_options", value: "--require=./hook.js" }]);
    expect(consent.names).toEqual(["API_KEY"]);
    expect(consent.added).toEqual(["node_options"]);
    expect(JSON.stringify(consent)).not.toContain("very-secret-value");
  });

  it("names what changed since the command line the operator confirmed before", () => {
    const consent = commandConsent(line, { program: "uvx", names: ["API_KEY", "TEAM"] });
    expect([consent.added, consent.removed, consent.programChanged]).toEqual([
      ["REGION"],
      ["TEAM"],
      true,
    ]);
  });
});
