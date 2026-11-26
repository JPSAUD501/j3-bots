// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyConnectorChange } from "@j3-bots/client-runtime/presentation";
import type { SignInRoute } from "@j3-bots/client-runtime/react";
import {
  type Connector,
  type ConnectorField,
  ConnectorGlyph,
  ConnectorId,
  ConnectorOrigin,
  type ConnectorListing,
  type ConnectorListingDetails,
  type ConnectorSource,
  type ConnectorTool,
  ConnectorToolName,
  CuratedKey,
  displayTransport,
  FieldKey,
  type ListingRef,
  RegistryName,
  SetupPageUrl,
  ToolReviewRevision,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import type { ConnectorsIntents } from "../components/connectors/screen";
import { ids, SAMPLE_NOW } from "./sample";

// The connectors of the sample team, and a gallery that answers as a server
// would, a little late so what waits on it shows. Every address is an
// example one; the text is the gallery's own.

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

const sampleListings: ReadonlyArray<ConnectorListing> = [
  {
    ref: curated("notion"),
    name: "Notion",
    summary: "Pages, notes and databases your bots read and write.",
    glyph: ConnectorGlyph.make("notebook"),
    publisher: { _tag: "domain", domain: "notion.com" },
    connect: "sign-in",
  },
  {
    ref: curated("linear"),
    name: "Linear",
    summary: "Issues and projects: what's open, who has it, what's next.",
    glyph: ConnectorGlyph.make("board"),
    publisher: { _tag: "domain", domain: "linear.app" },
    connect: "sign-in",
  },
  {
    ref: curated("google-calendar"),
    name: "Google Calendar",
    summary: "Your events, free time and invitations.",
    glyph: ConnectorGlyph.make("calendar"),
    publisher: { _tag: "domain", domain: "google.com" },
    connect: "own-app",
  },
  {
    ref: curated("sentry"),
    name: "Sentry",
    summary: "Errors and releases, to look into what broke and when.",
    glyph: null,
    publisher: { _tag: "domain", domain: "sentry.io" },
    connect: "token",
  },
  {
    ref: { _tag: "registry", name: RegistryName.make("io.example/files") },
    name: "Local files",
    summary: "Reads and writes files in a folder on the server.",
    glyph: ConnectorGlyph.make("folder"),
    publisher: { _tag: "community", namespace: "io.example" },
    connect: "command",
  },
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
const regionField: ConnectorField = {
  key: FieldKey.make("region"),
  label: "Data region",
  description: "Where your organization's data is kept.",
  secret: false,
  required: true,
  placeholder: null,
  choices: ["United States", "Germany"],
};

const descriptions: Record<string, string> = {
  notion:
    "Lets your bots search your workspace, read pages and databases, and add or change pages in the ones you share with them. Your bots see only what the account you sign in with can see.",
  linear:
    "Lets your bots read issues and projects, open issues, and comment on them, as the account you sign in with.",
  "google-calendar":
    "Lets your bots read your calendars, find free time, and add or change events. Google asks that you register an app of your own for this, once.",
  sentry: "Lets your bots look up errors, the releases they came with, and how often they happen.",
};

/** A listing's page, as `connectors.get` answers it. */
function sampleDetails(ref: ListingRef): ConnectorListingDetails | undefined {
  const listing = sampleListings.find(
    (candidate) =>
      candidate.ref._tag === ref._tag &&
      (candidate.ref._tag === "curated" && ref._tag === "curated"
        ? candidate.ref.key === ref.key
        : candidate.ref._tag === "registry" &&
          ref._tag === "registry" &&
          candidate.ref.name === ref.name),
  );
  if (listing === undefined) return undefined;
  const key = listing.ref._tag === "curated" ? listing.ref.key : "";
  return {
    ...listing,
    description: descriptions[key] ?? listing.summary,
    fields: listing.connect === "token" ? [tokenField, regionField] : [],
    setup:
      listing.connect === "own-app"
        ? {
            steps: [
              "Open the cloud console and make a project for J3 Bots.",
              "Turn on the Calendar API for it.",
              "Make an OAuth client of the desktop app kind.",
              "Copy its client ID and secret here.",
            ],
            url: SetupPageUrl.make("https://console.example.com/credentials"),
            issuer: "https://accounts.example.com",
          }
        : listing.connect === "token"
          ? {
              steps: [
                "Open your organization's settings, then Auth tokens.",
                "Make a token with read access to issues and releases, and copy it here.",
              ],
              url: SetupPageUrl.make("https://errors.example.com/settings/auth-tokens"),
              issuer: null,
            }
          : null,
    command:
      listing.connect === "command"
        ? { command: "npx", args: ["-y", "@example/files-server", "~/Shared"], env: [] }
        : null,
    tools: key === "notion" ? notesTools : null,
    redirects:
      listing.connect === "own-app"
        ? {
            server: "https://bots.example.com/oauth/callback/accounts.example.com",
            loopback: "http://127.0.0.1/oauth/callback/accounts.example.com",
          }
        : null,
  };
}

const connectorId = (suffix: string) => ConnectorId.make(`conn_sample${suffix.padEnd(11, "0")}`);

const base = {
  glyph: null,
  fields: [],
  account: null,
  signedInAt: null,
  review: null,
  createdAt: ago(60 * 24 * 12),
  lastChange: null,
} as const;

/** The sample team's connectors: one of each status, and one with tool changes to review. */
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
    review: {
      revision: ToolReviewRevision.make("r2"),
      changes: [
        {
          _tag: "added",
          tool: tool("resolve_issue", "Resolve an error", "Marks an error resolved in a release."),
        },
        {
          _tag: "changed",
          tool: tool(
            "search_issues",
            "Search errors",
            "Finds errors and the events of each, by message, release, tag or user.",
          ),
          previous: tool(
            "search_issues",
            "Search errors",
            "Finds errors by message, release or tag.",
          ),
          inputChanged: true,
        },
      ],
      kept: false,
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
    status: { _tag: "vault-locked" },
    grant: { _tag: "bots", ids: [ids.pip] },
    tools: [tool("lights", "Lights", "Turns the lights in a room on or off.")],
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

let added = 0;

/** A connector as the sample's server adds it from `source`. */
const fromSource = (source: ConnectorSource, grant: Connector["grant"]): Connector => {
  added += 1;
  const id = connectorId(`added${added}`);
  const listing = source._tag === "listing" ? sampleDetails(source.ref) : undefined;
  const signsIn = listing?.connect === "sign-in" || listing?.connect === "own-app";
  return {
    ...base,
    id,
    name: source._tag === "listing" ? (listing?.name ?? "Connector") : source.name,
    publisher: listing?.publisher ?? { _tag: "operator" },
    listing: source._tag === "listing" ? source.ref : null,
    glyph: listing?.glyph ?? null,
    transport:
      source._tag === "listing"
        ? { _tag: "remote", origin: ConnectorOrigin.make("https://new.example.com") }
        : displayTransport(source),
    signIn: signsIn ? "oauth" : (listing?.fields.length ?? 0) > 0 ? "fields" : "none",
    fields: listing?.fields ?? [],
    status: signsIn ? { _tag: "needs-sign-in", reason: "not-signed-in" } : { _tag: "connected" },
    grant,
    tools: listing?.tools ?? [],
    createdAt: SAMPLE_NOW,
    lastChange: { by: { _tag: "operator" }, at: SAMPLE_NOW },
  };
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
    featured: () => done(sampleListings.slice(0, 4)),
    search: ({ query, all }) => {
      const words = query.toLocaleLowerCase();
      return done({
        listings: sampleListings.filter(
          (listing) =>
            (all || (listing.connect !== "command" && listing.connect !== "unsupported")) &&
            `${listing.name} ${listing.summary}`.toLocaleLowerCase().includes(words),
        ),
        registry: "answered",
      });
    },
    listing: (ref) => {
      const details = sampleDetails(ref);
      return details === undefined ? failed() : done(details);
    },
    add: ({ source, grant }) => save(fromSource(source, grant ?? { _tag: "all-bots" })),
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
    answerToolReview: (id, _revision, decision) => {
      const connector = find(id);
      if (connector === undefined || connector.review === null) return failed();
      if (decision === "keep")
        return save({ ...connector, review: { ...connector.review, kept: true } });
      const tools = applyTools(
        connector.tools,
        connector.review.changes.map((change) => change.tool),
      );
      return save({ ...connector, tools, review: null });
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
    openVault: () => {},
  };
}

/** `tools` with each of `changed` in place of the one of its name, or after them. */
const applyTools = (
  tools: ReadonlyArray<ConnectorTool>,
  changed: ReadonlyArray<ConnectorTool>,
): ReadonlyArray<ConnectorTool> => {
  const kept = tools.map(
    (current) => changed.find((next) => next.name === current.name) ?? current,
  );
  return [
    ...kept,
    ...changed.filter((next) => !tools.some((current) => current.name === next.name)),
  ];
};

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
