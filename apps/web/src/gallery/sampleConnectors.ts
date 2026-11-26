// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentResult } from "@j3-bots/client-runtime";
import { applyConnectorChange, type OwnAppSetup } from "@j3-bots/client-runtime/presentation";
import type { SignInRoute } from "@j3-bots/client-runtime/react";
import {
  type Connector,
  type ConnectorField,
  ConnectorGlyph,
  ConnectorId,
  ConnectorOrigin,
  type ConnectorPrompt,
  type ConnectorTool,
  ConnectorToolName,
  CuratedKey,
  FieldKey,
  type ListingRef,
  SecretName,
  SetupPageUrl,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import type { ConnectorsIntents } from "../components/connectors/screen";
import { ids, SAMPLE_NOW } from "./sample";

// The connectors of the sample team, and a server that answers for them, a
// little late so what waits on it shows. Every address is an example one.

const ago = (minutes: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - minutes * 60_000);

const tool = (name: string, title: string, description: string): ConnectorTool => ({
  name: ConnectorToolName.make(name),
  title,
  description,
});

const curated = (key: string): ListingRef => ({ _tag: "curated", key: CuratedKey.make(key) });

const notesTools = [
  tool("search_pages", "Search pages", "Finds pages and databases by their words."),
  tool("read_page", "Read a page", "Reads a page, with its blocks and properties."),
  tool("create_page", "Create a page", "Adds a page under one the bot can reach."),
  tool("update_page", "Update a page", "Changes a page's properties or adds blocks to it."),
  tool("list_databases", "List databases", "Lists the databases the bot can reach."),
  tool("query_database", "Query a database", "Reads the rows of a database that match a filter."),
];

const trackerTools = [
  tool("list_issues", "List issues", "Lists issues by team, state or who they're assigned to."),
  tool(
    "create_issue",
    "Create an issue",
    "Opens an issue in a team, with a title and a description.",
  ),
  tool("comment", "Comment", "Adds a comment to an issue."),
];

const token = FieldKey.make("token");
const tokenField: ConnectorField = {
  key: token,
  label: "Auth token",
  description: null,
  secret: true,
  required: true,
  placeholder: null,
  choices: [],
};
const connectorId = (suffix: string) => ConnectorId.make(`conn_sample${suffix.padEnd(11, "0")}`);

/** The prompts the sample's Notion offers, for the `/` menu, each with how its server writes it. */
const SAMPLE_PROMPTS: ReadonlyArray<
  ConnectorPrompt & { readonly render: (given: Readonly<Record<string, string>>) => string }
> = [
  {
    connectorId: connectorId("notion"),
    name: "weekly-review",
    title: "Weekly review",
    description: "Sums up the pages changed this week.",
    arguments: [
      {
        name: "team",
        title: "Team",
        description: "Whose pages to look at",
        required: true,
      },
      { name: "since", title: "Since", description: "A date, if not this week", required: false },
    ],
    render: (given) =>
      `Review the pages ${given["team"] ?? ""} changed ${given["since"] === undefined ? "this week" : `since ${given["since"]}`}: what moved, what is stuck, and what needs a decision.`,
  },
  {
    connectorId: connectorId("notion"),
    name: "meeting-notes",
    title: "Meeting notes",
    description: "Turns a page of notes into decisions and next steps.",
    arguments: [],
    render: () => "Read my latest meeting page and list the decisions, the owners and the dates.",
  },
];

const base = {
  glyph: null,
  fields: [],
  account: null,
  signedInAt: null,
  server: null,
  createdAt: ago(60 * 24 * 12),
  lastChange: null,
} as const;

/** The sample team's connectors: one of each status. */
export const sampleConnectors: ReadonlyArray<Connector> = [
  {
    ...base,
    id: connectorId("notion"),
    name: "Notion",
    glyph: ConnectorGlyph.make("notebook"),
    publisher: { _tag: "domain", domain: "notion.com" },
    listing: curated("notion"),
    transport: { _tag: "remote", origin: ConnectorOrigin.make("https://notes.example.com") },
    signIn: "oauth",
    status: { _tag: "connected" },
    grant: { _tag: "all-bots" },
    account: "sam@example.com",
    signedInAt: ago(60 * 24 * 12),
    tools: notesTools,
    lastChange: { by: { _tag: "operator" }, at: ago(60 * 24 * 12) },
    server: {
      protocolVersion: "2026-07-28",
      name: "Notes",
      version: "3.2.0",
      tools: notesTools.length,
      resources: 12,
      prompts: SAMPLE_PROMPTS.length,
    },
  },
  {
    ...base,
    id: connectorId("linear"),
    name: "Linear",
    glyph: ConnectorGlyph.make("board"),
    publisher: { _tag: "domain", domain: "linear.app" },
    listing: curated("linear"),
    transport: { _tag: "remote", origin: ConnectorOrigin.make("https://tracker.example.com") },
    signIn: "oauth",
    status: { _tag: "needs-sign-in", reason: "expired" },
    grant: { _tag: "bots", ids: [ids.atlas, ids.scout] },
    account: "sam@example.com",
    signedInAt: ago(60 * 24 * 30),
    tools: trackerTools,
    lastChange: { by: { _tag: "bot", botId: ids.scout }, at: ago(60 * 24 * 30) },
  },
  {
    ...base,
    id: connectorId("sentry"),
    name: "Sentry",
    publisher: { _tag: "domain", domain: "sentry.io" },
    listing: curated("sentry"),
    transport: { _tag: "remote", origin: ConnectorOrigin.make("https://errors.example.com") },
    signIn: "fields",
    fields: [tokenField],
    status: { _tag: "failing", reason: "timed-out", since: ago(25) },
    grant: { _tag: "bots", ids: [ids.atlas] },
    signedInAt: ago(60 * 24 * 3),
    tools: [tool("search_issues", "Search errors", "Finds errors by message, release or tag.")],
    server: {
      protocolVersion: "2025-11-25",
      name: null,
      version: null,
      tools: 1,
      resources: 0,
      prompts: 0,
    },
  },
  {
    ...base,
    id: connectorId("homelab"),
    name: "Home lab",
    publisher: { _tag: "operator" },
    listing: null,
    transport: { _tag: "remote", origin: ConnectorOrigin.make("https://lab.example.net") },
    signIn: "none",
    status: { _tag: "secrets-unavailable" },
    grant: { _tag: "bots", ids: [ids.pip] },
    tools: [tool("lights", "Lights", "Turns the lights in a room on or off.")],
  },
  {
    ...base,
    id: connectorId("weather"),
    name: "Weather station",
    publisher: { _tag: "operator" },
    listing: null,
    transport: { _tag: "remote", origin: ConnectorOrigin.make("https://weather.example.net") },
    signIn: "none",
    status: { _tag: "needs-secret", secret: SecretName.make("weather-key"), reason: "not-shared" },
    grant: { _tag: "bots", ids: [ids.atlas, ids.pip] },
    tools: [tool("forecast", "Forecast", "Tells the forecast for the days ahead.")],
  },
  {
    ...base,
    id: connectorId("files"),
    name: "Local files",
    glyph: ConnectorGlyph.make("folder"),
    publisher: { _tag: "operator" },
    listing: null,
    transport: { _tag: "command", program: "npx" },
    signIn: "none",
    fields: [{ ...tokenField, key: FieldKey.make("FILES_TOKEN"), label: "FILES_TOKEN" }],
    status: { _tag: "connected" },
    grant: { _tag: "bots", ids: [ids.atlas] },
    tools: [tool("read_file", "Read a file", "Reads a file in the shared folder.")],
    lastChange: { by: { _tag: "bot", botId: ids.atlas }, at: ago(90) },
  },
];

/** The connectors a source of the sample holds, and a way to change them. */
export interface ConnectorsHolder {
  readonly get: () => ReadonlyArray<Connector>;
  readonly change: (upsert: ReadonlyArray<Connector>, remove: ReadonlyArray<ConnectorId>) => void;
}

/** How long the sample's server takes to answer. */
const ANSWER_DELAY = 450;

const later = <A>(value: A): Promise<A> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ANSWER_DELAY));
const done = <A>(value: A) => later({ _tag: "done", value } as const);
const failed = () => later({ _tag: "failed", failure: { _tag: "unexpected" } } as const);

/** The connector a yes to a bot's ask adds in the sample. */
export const SAMPLE_ASKED_CONNECTOR = connectorId("home-lights");

/**
 * The own app's setup a bot's ask to add a gallery entry shows, as the
 * sample's server answers it, a little late.
 */
export const sampleOwnAppSetup = (): Promise<IntentResult<OwnAppSetup>> =>
  done({
    steps: [
      "Open the developer console of the service and create a project.",
      "Add an OAuth client of the kind “Web application”.",
      "Add the redirect address below to it, then copy its client ID and secret.",
    ],
    url: SetupPageUrl.make("https://console.example.com/credentials"),
    redirect: "https://bots.example.com/connectors/sign-in/return",
  });

/** How the sample's servers answer the composer's `/` menu: Notion offers two prompts. */
export const samplePromptIntents: Pick<ConnectorsIntents, "prompts" | "renderPrompt"> = {
  prompts: () => done(SAMPLE_PROMPTS),
  renderPrompt: ({ name, arguments: given }) => {
    const prompt = SAMPLE_PROMPTS.find((one) => one.name === name);
    if (prompt === undefined) return failed();
    return done({ text: prompt.render(given), cut: false });
  },
};

/**
 * What the connectors screen asks of the sample's server. Every value it is
 * handed stays redacted: the sample keeps none.
 */
export function sampleConnectorsIntents(
  holder: ConnectorsHolder,
  signInRoute: SignInRoute = { _tag: "paste" },
): ConnectorsIntents {
  const find = (id: ConnectorId) => holder.get().find((connector) => connector.id === id);
  const save = (connector: Connector) => {
    holder.change([connector], []);
    return done(connector);
  };
  let signingIn: ConnectorId | null = null;
  return {
    ...samplePromptIntents,
    update: (id) => {
      const connector = find(id);
      return connector === undefined
        ? failed()
        : save({ ...connector, status: { _tag: "connected" }, signedInAt: SAMPLE_NOW });
    },
    remove: (id) => {
      holder.change([], [id]);
      return done(undefined);
    },
    setBots: (id, grant) => {
      const connector = find(id);
      return connector === undefined ? failed() : save({ ...connector, grant });
    },
    beginSignIn: (id) => {
      signingIn = id;
      return done({
        authorizationUrl: Redacted.make("https://auth.example.com/authorize?state=sample"),
        expiresAt: DateTime.makeUnsafe(Date.now() + 10 * 60_000),
      });
    },
    completeSignIn: () => {
      const connector = signingIn === null ? undefined : find(signingIn);
      signingIn = null;
      if (connector === undefined) return failed();
      holder.change([{ ...connector, status: { _tag: "connected" }, signedInAt: SAMPLE_NOW }], []);
      return done(undefined);
    },
    signInRoute,
    openPage: () => {},
    openSecrets: () => {},
  };
}

/** A holder of its own, for a gallery frame: it starts from `initial` and keeps its changes. */
export function connectorsHolder(
  initial: ReadonlyArray<Connector>,
  onChange: (connectors: ReadonlyArray<Connector>) => void,
): ConnectorsHolder {
  let current = initial;
  return {
    get: () => current,
    change: (upsert, remove) => {
      current = applyConnectorChange(current, upsert, remove);
      onChange(current);
    },
  };
}
