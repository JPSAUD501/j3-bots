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
  commandSource,
  listingSource,
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
      listingSource({ ref, fields, values: new Map([[token, " key "]]), client: null }),
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
      problems(listingSource({ ref, fields, values: new Map(), client: null })).missing,
    ).toEqual([token]);
    const own = problems(listingSource({ ref, fields: [], values: new Map(), client: noClient }));
    expect([own.issuer, own.clientId]).toEqual([true, true]);
  });

  it("sends an own app's client with the issuer it is registered at", () => {
    const source = ready(
      listingSource({
        ref,
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
        args: "-y\n\n  @scope/server  \n/home/me",
        env: [{ name: "API_KEY", value: "k" }],
      }),
    );
    if (source._tag !== "command") throw new Error(source._tag);
    // An argument can carry a key, so each leaves the form redacted.
    expect(source.args.map(plain)).toEqual(["-y", "@scope/server", "/home/me"]);
    expect(source.env.map((variable) => [variable.name, plain(variable.value)])).toEqual([
      ["API_KEY", "k"],
    ]);
  });

  it("asks for a name and a command, and refuses a variable name a shell does not allow", () => {
    const refused = problems(
      commandSource({ name: " ", command: "", args: "", env: [{ name: "1KEY", value: "" }] }),
    );
    expect([refused.name, refused.command, refused.env]).toEqual([true, true, [0]]);
  });

  it("refuses an argument longer than a command line takes", () => {
    const refused = problems(
      commandSource({ name: "Files", command: "npx", args: "x".repeat(4_001), env: [] }),
    );
    expect(refused.args).toBe(true);
  });
});
