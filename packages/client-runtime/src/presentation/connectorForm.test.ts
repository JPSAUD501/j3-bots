// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectorField,
  type ConnectorSource,
  CuratedKey,
  FieldKey,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import {
  type ArgumentsDraft,
  commandConsent,
  type CommandEdit,
  commandEdit,
  commandSource,
  listingSource,
  refillValues,
  remoteSource,
  type SourceDraft,
  withoutSecrets,
} from "./connectorForm.ts";

const ready = (draft: SourceDraft): ConnectorSource => {
  if (draft._tag !== "ready") throw new Error(`Refused: ${JSON.stringify(draft.problems)}`);
  return draft.source;
};
const problems = (draft: SourceDraft) => {
  if (draft._tag !== "invalid") throw new Error("Accepted");
  return draft.problems;
};
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
const ref = { _tag: "curated", key: CuratedKey.make("linear") } as const;
const noClient = { issuer: "", clientId: "", clientSecret: "" };

describe("a gallery entry's form", () => {
  it("sends each value it was given, redacted, and leaves out an empty optional one", () => {
    const source = ready(
      listingSource({
        ref,
        language: "en",
        fields,
        values: new Map([[token, " key "]]),
        client: null,
      }),
    );
    if (source._tag !== "listing") throw new Error(source._tag);
    // A secret is sent exactly as typed; spaces may be part of it.
    expect(source.values.map((value) => [value.key, plain(value.value)])).toEqual([
      [token, " key "],
    ]);
    expect(source.oauthClient).toBeNull();
  });

  it("asks for a required field left empty, and an own app's whole client", () => {
    expect(
      problems(listingSource({ ref, language: "en", fields, values: new Map(), client: null }))
        .missing,
    ).toEqual([token]);
    const own = problems(
      listingSource({ ref, language: "en", fields: [], values: new Map(), client: noClient }),
    );
    expect([own.issuer, own.clientId]).toEqual([true, true]);
  });

  it("sends an own app's client with the issuer it is registered at", () => {
    const source = ready(
      listingSource({
        ref,
        language: "en",
        fields: [],
        values: new Map(),
        client: { issuer: " https://accounts.example.com ", clientId: " app ", clientSecret: "s" },
      }),
    );
    if (source._tag !== "listing" || source.oauthClient === null) throw new Error("No client");
    expect(source.oauthClient.issuer).toBe("https://accounts.example.com");
    expect(source.oauthClient.clientId).toBe("app");
    expect(source.oauthClient.clientSecret && plain(source.oauthClient.clientSecret)).toBe("s");
  });
});

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

describe("a connector added by its address", () => {
  const base = {
    name: "",
    url: "https://mcp.example.com/mcp",
    headers: [],
    client: noClient,
    privateNetwork: false,
  };

  it("takes the host for a name and drops blank header rows", () => {
    const source = ready(
      remoteSource({
        ...base,
        headers: [
          { name: "", value: "" },
          { name: "X-Api-Key", value: "k" },
        ],
      }),
    );
    if (source._tag !== "remote") throw new Error(source._tag);
    expect(source.name).toBe("mcp.example.com");
    // A path or query can carry a key, so the address leaves the form redacted.
    expect(plain(source.url)).toBe("https://mcp.example.com/mcp");
    expect(source.headers.map((header) => [header.name, plain(header.value)])).toEqual([
      ["X-Api-Key", "k"],
    ]);
  });

  it("refuses an address that is not https and a header name HTTP does not allow", () => {
    expect(problems(remoteSource({ ...base, url: "http://mcp.example.com" })).url).toBe(true);
    expect(
      problems(remoteSource({ ...base, headers: [{ name: "Bad Name", value: "v" }] })).headers,
    ).toEqual([0]);
  });

  it("refuses a client without its id or with an issuer that is not https, and sends none when it is empty", () => {
    const withSecret = problems(
      remoteSource({ ...base, client: { ...noClient, clientSecret: "s" } }),
    );
    expect([withSecret.issuer, withSecret.clientId]).toEqual([true, true]);
    const plainHttp = problems(
      remoteSource({
        ...base,
        client: { issuer: "http://accounts.example.com", clientId: "app", clientSecret: "" },
      }),
    );
    expect([plainHttp.issuer, plainHttp.clientId]).toEqual([true, false]);
    const source = ready(remoteSource(base));
    expect(source._tag === "remote" && source.oauthClient).toBeNull();
  });
});

describe("a connector started by command", () => {
  it("takes one argument a line, blank lines dropped, and its environment", () => {
    const source = ready(
      commandSource({
        name: "Files",
        command: "npx",
        args: "-y\n\n  @scope/server@1.2.3  \n/home/me",
        env: [{ name: "API_KEY", value: "k" }],
      }),
    );
    if (source._tag !== "command") throw new Error(source._tag);
    // An argument can carry a key, so each leaves the form redacted.
    expect(source.args.map(plain)).toEqual(["-y", "@scope/server@1.2.3", "/home/me"]);
    expect(source.env.map((variable) => [variable.name, plain(variable.value)])).toEqual([
      ["API_KEY", "k"],
    ]);
  });

  it("asks for a name and a command, and refuses a variable name a shell does not allow", () => {
    const refused = problems(
      commandSource({ name: " ", command: "", args: "", env: [{ name: "1KEY", value: "" }] }),
    );
    expect([refused.name, refused.command, refused.env]).toEqual([
      true,
      true,
      [{ index: 0, reason: "invalid" }],
    ]);
  });

  it("says before the server does that a package runs at no exact version", () => {
    const command = (args: string, env: ReadonlyArray<{ name: string; value: string }> = []) =>
      commandSource({ name: "Files", command: "npx", args, env });
    expect(problems(command("-y\n@scope/server")).pin).toBe("floating");
    expect(problems(command("@scope/server@latest")).pin).toBe("floating");
    expect(problems(command("-c\nserver")).pin).toBe("shell");
    // A launcher setting can choose another package, whatever the arguments say.
    expect(
      problems(command("@scope/server@1.2.3", [{ name: "npm_config_registry", value: "x" }])).pin,
    ).toBe("unclear");
    expect(ready(command("@scope/server@1.2.3"))._tag).toBe("command");
    // A program no launcher reads runs as it is given.
    expect(
      ready(commandSource({ name: "Files", command: "/opt/server", args: "--serve", env: [] }))
        ._tag,
    ).toBe("command");
  });

  it("refuses a variable the server reads to start the program, and one named twice in any case", () => {
    const refused = problems(
      commandSource({
        name: "Files",
        command: "node",
        args: "server.js",
        env: [
          { name: "Path", value: "/tmp" },
          { name: "API_KEY", value: "a" },
          { name: "api_key", value: "b" },
        ],
      }),
    );
    expect(refused.env).toEqual([
      { index: 0, reason: "reserved" },
      { index: 2, reason: "twice" },
    ]);
  });

  it("refuses a secret as the value of a variable that decides which code runs, and takes it elsewhere", () => {
    const refused = problems(
      commandSource({
        name: "Files",
        command: "python",
        args: "server.py",
        env: [
          { name: "API_KEY", value: "${secret:files-key}" },
          { name: "PythonPath", value: "/srv/lib:${secret:lib-path}" },
        ],
      }),
    );
    expect(refused.env).toEqual([{ index: 1, reason: "code-secret" }]);
  });

  it("refuses an argument longer than a command line takes", () => {
    const refused = problems(
      commandSource({ name: "Files", command: "npx", args: "x".repeat(4_001), env: [] }),
    );
    expect(refused.args).toBe(true);
  });
});

describe("an edit of a connector started by command", () => {
  const known = { program: "npx", names: ["API_KEY", "TEAM"] };
  const kept: ArgumentsDraft = { _tag: "kept" };
  const typed = (text: string): ArgumentsDraft => ({ _tag: "typed", text });
  const edit = (
    command: string,
    args: ArgumentsDraft,
    env: ReadonlyArray<{ name: string; value: string }>,
  ): CommandEdit => commandEdit(known, { command, args, env });
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
    const line = (env: ReadonlyArray<{ name: string; value: string }>) =>
      edit("npx", typed("@scope/server@1.2.3"), env);
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
  const line = ready(
    commandSource({
      name: "Files",
      command: "npx",
      args: "-y\n@scope/server@1.2.3",
      env: [
        { name: "API_KEY", value: "very-secret-value" },
        { name: "REGION", value: "eu" },
      ],
    }),
  );
  if (line._tag !== "command") throw new Error(line._tag);

  it("shows the whole command line and every variable's name, never a value", () => {
    const consent = commandConsent(line, null);
    expect([consent.program, ...consent.args]).toEqual(["npx", "-y", "@scope/server@1.2.3"]);
    expect(consent.names).toEqual(["API_KEY", "REGION"]);
    expect(JSON.stringify(consent)).not.toContain("very-secret-value");
    expect([consent.added, consent.removed, consent.programChanged]).toEqual([[], [], false]);
  });

  it("shows a variable that decides which code runs with its value, as part of the line", () => {
    const withOptions = ready(
      commandSource({
        name: "Files",
        command: "npx",
        args: "-y\n@scope/server@1.2.3",
        env: [
          { name: "API_KEY", value: "very-secret-value" },
          { name: "node_options", value: "--require=./hook.js" },
        ],
      }),
    );
    if (withOptions._tag !== "command") throw new Error(withOptions._tag);
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
