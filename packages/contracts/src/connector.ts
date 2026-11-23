// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { BotId, Label, OpenLiterals } from "./base.ts";

// ---------------------------------------------------------------------------
// Connectors: services a bot uses through J3 Bots, which the operator signs
// in to once, on the server (docs/architecture/server.md, "Connectors";
// decisions 0026 and 0027). A connector is a remote MCP server, or one the
// server starts by command. Its sign-in and its secrets stay on the server:
// no token, key, code or header value is ever in what the server sends, and
// every value a client sends for one travels as a redacted type, which
// prints as `<redacted>`.
// ---------------------------------------------------------------------------

/**
 * A connector's id. The client that adds it chooses it, so adding again after
 * a lost reply finds the connector it added instead of adding another.
 */
export const ConnectorId = Schema.String.check(Schema.isPattern(/^conn_[0-9a-z]{16,40}$/)).pipe(
  Schema.brand("ConnectorId"),
);
export type ConnectorId = typeof ConnectorId.Type;

/**
 * One of J3 Bots' own glyphs for a service, by name. Clients draw it from the
 * set they ship; one they do not have, as from a newer server, is drawn as the
 * connector's first letter. Never a remote image, and never a vendor's logo.
 */
export const ConnectorGlyph = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/),
).pipe(Schema.brand("ConnectorGlyph"));
export type ConnectorGlyph = typeof ConnectorGlyph.Type;

// Not `link.ts`'s parser: that module reaches the entries, which reach this one.
const parseUrl: (text: string) => Option.Option<URL> = Option.liftThrowable(
  (text: string) => new URL(text),
);

/** The longest address a connector, or a page it links to, takes. */
export const MAX_CONNECTOR_URL_LENGTH = 2_048;

const httpsUrl = (url: URL) =>
  url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";

const HttpsAddress = Schema.String.check(
  Schema.isMaxLength(MAX_CONNECTOR_URL_LENGTH),
  Schema.makeFilter(
    (text: string) =>
      Option.exists(parseUrl(text), httpsUrl) || "an https: address with no user name or fragment",
  ),
);

/**
 * Where a remote connector answers: an `https:` address with no user name,
 * password or fragment. Whether its host may be reached at all (an address in
 * the operator's own network, after DNS) is the server's to check when it
 * connects, not the contract's.
 */
export const ConnectorUrl = HttpsAddress.pipe(Schema.brand("ConnectorUrl"));
export type ConnectorUrl = typeof ConnectorUrl.Type;

/** A page the operator opens to set a connector up, such as where to make a token. */
export const SetupPageUrl = HttpsAddress.pipe(Schema.brand("SetupPageUrl"));
export type SetupPageUrl = typeof SetupPageUrl.Type;

/** An entry of J3 Bots' own curated list, by its key. */
export const CuratedKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("CuratedKey"),
);
export type CuratedKey = typeof CuratedKey.Type;

/** A server's name in the MCP Registry: its namespace, a slash, its own name. */
export const RegistryName = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
).pipe(Schema.brand("RegistryName"));
export type RegistryName = typeof RegistryName.Type;

/** A connector the gallery offers: an entry of the curated list, or of the MCP Registry. */
export const ListingRef = Schema.Union([
  Schema.TaggedStruct("curated", { key: CuratedKey }),
  Schema.TaggedStruct("registry", { name: RegistryName }),
]);
export type ListingRef = typeof ListingRef.Type;

/**
 * Who offers a connector, as its page says it:
 * - `domain`: the publisher's domain owns the server's host ("From notion.com"),
 *   a signal J3 Bots computes, never a verification it vouches for;
 * - `community`: anyone else, by the namespace that published it;
 * - `operator`: added by address or by command on this server.
 */
export const ConnectorPublisher = Schema.Union([
  Schema.TaggedStruct("domain", { domain: Label }),
  Schema.TaggedStruct("community", { namespace: Label }),
  Schema.TaggedStruct("operator", {}),
]);
export type ConnectorPublisher = typeof ConnectorPublisher.Type;

/**
 * How a listing connects, which its card and its Connect button say:
 * - `sign-in`: a sign-in in the browser, with nothing to set up first;
 * - `own-app`: a sign-in with an OAuth client the operator registers at the
 *   service and pastes, following the listing's setup steps;
 * - `token`: a key or token the operator pastes, sent in a header;
 * - `open`: nothing to give;
 * - `command`: started on the server by a command, web and desktop only;
 * - `unsupported`: J3 Bots cannot connect it yet, such as a server reached
 *   only over the legacy SSE transport.
 */
export const ConnectKind = Schema.Literals([
  "sign-in",
  "own-app",
  "token",
  "open",
  "command",
  "unsupported",
]);
export type ConnectKind = typeof ConnectKind.Type;

/** The most characters a connector's one-line summary has. */
export const MAX_CONNECTOR_SUMMARY_LENGTH = 300;
/** The most characters a connector's description, or a tool's, has. */
export const MAX_CONNECTOR_DESCRIPTION_LENGTH = 4_000;
export const MAX_TOOL_DESCRIPTION_LENGTH = 1_024;

/**
 * A connector in the gallery, as a card shows it. The text is J3 Bots' own
 * for a curated entry, in the language the client asked for, and the
 * registry's, cut short, for any other.
 */
export const ConnectorListing = Schema.Struct({
  ref: ListingRef,
  name: Label,
  summary: Schema.String.check(Schema.isMaxLength(MAX_CONNECTOR_SUMMARY_LENGTH)),
  glyph: Schema.NullOr(ConnectorGlyph),
  publisher: ConnectorPublisher,
  connect: ConnectKind,
});
export type ConnectorListing = typeof ConnectorListing.Type;

/** A field of a connect form: a header, a part of the server's address, an environment variable. */
export const FieldKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[\x21-\x7e]+$/),
).pipe(Schema.brand("FieldKey"));
export type FieldKey = typeof FieldKey.Type;

/** One field the connect form asks for. A `secret` field is masked, and its value is never shown again. */
export const ConnectorField = Schema.Struct({
  key: FieldKey,
  label: Label,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
  secret: Schema.Boolean,
  required: Schema.Boolean,
  placeholder: Schema.NullOr(Label),
});
export type ConnectorField = typeof ConnectorField.Type;

/** What the operator does at the service before connecting: an app to register, a token to make. */
export const ConnectorSetup = Schema.Struct({
  steps: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))).check(
    Schema.isMaxLength(10),
  ),
  /** The page where the steps start. */
  url: Schema.NullOr(SetupPageUrl),
});
export type ConnectorSetup = typeof ConnectorSetup.Type;

/**
 * A server started by command on J3 Bots' machine, as its user: the whole
 * command line, which the operator confirms before it runs, and the names of
 * the environment variables it is given, never their values.
 */
export const ConnectorCommand = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000))).check(Schema.isMaxLength(64)),
  env: Schema.Array(FieldKey).check(Schema.isMaxLength(64)),
});
export type ConnectorCommand = typeof ConnectorCommand.Type;

/** A tool's name, as the connector's server gives it. */
export const ConnectorToolName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("ConnectorToolName"));
export type ConnectorToolName = typeof ConnectorToolName.Type;

/**
 * A tool a connector offers, as the operator reads it before bots may use it.
 * The text is the connector's own, untrusted, with control and format
 * characters taken out.
 */
export const ConnectorTool = Schema.Struct({
  name: ConnectorToolName,
  title: Schema.NullOr(Label),
  description: Schema.String.check(Schema.isMaxLength(MAX_TOOL_DESCRIPTION_LENGTH)),
});
export type ConnectorTool = typeof ConnectorTool.Type;

/** A listing as its page shows it, with what Connect asks for. */
export const ConnectorListingDetails = Schema.Struct({
  ...ConnectorListing.fields,
  description: Schema.String.check(Schema.isMaxLength(MAX_CONNECTOR_DESCRIPTION_LENGTH)),
  /** The fields the connect form shows, in order. */
  fields: Schema.Array(ConnectorField).check(Schema.isMaxLength(32)),
  setup: Schema.NullOr(ConnectorSetup),
  /** For a `command` listing, what it runs. */
  command: Schema.NullOr(ConnectorCommand),
  /** The tools it offers, when its server lists them without a sign-in; null when they show only once connected. */
  tools: Schema.NullOr(Schema.Array(ConnectorTool)),
});
export type ConnectorListingDetails = typeof ConnectorListingDetails.Type;

/**
 * Which bots may use a connector: every bot, those made later included, or
 * these. A list may be empty, as when the one bot it named was deleted.
 */
export const ConnectorGrant = Schema.Union([
  Schema.TaggedStruct("all-bots", {}),
  Schema.TaggedStruct("bots", { ids: Schema.Array(BotId).check(Schema.isMaxLength(1_000)) }),
]);
export type ConnectorGrant = typeof ConnectorGrant.Type;

/**
 * Why a connector needs the operator to sign in: it never was, the service
 * ended the sign-in (a refresh refused, a revoked consent, a fixed lifetime),
 * or it refused the token or key the operator gave.
 */
export const SIGN_IN_REASONS = ["not-signed-in", "expired", "rejected"] as const;

/**
 * Why J3 Bots cannot use a connector, in J3 Bots' own words: never the
 * server's text, which is untrusted and can echo what it was sent.
 * - `unreachable`: no connection, or a network error;
 * - `timed-out`: it took too long to answer;
 * - `server-error`: it answered with an error of its own;
 * - `not-mcp`: what it answered is not an MCP server's answer;
 * - `refused-address`: its address leads into the operator's own network,
 *   which J3 Bots does not reach for a connector the operator did not allow so.
 */
export const FAILURE_REASONS = [
  "unreachable",
  "timed-out",
  "server-error",
  "not-mcp",
  "refused-address",
] as const;

/**
 * Whether bots can use a connector now. The reasons are open: one added after
 * a client's build decodes as `unknown`, which it words as a connector that
 * needs a sign-in, or that cannot be reached, without saying why.
 *
 * - `connected`: its last call or sign-in renewal worked;
 * - `needs-sign-in`: bots get none of its tools until the operator signs in
 *   again, or gives a new token;
 * - `failing`: it has not answered as it should since `since`; bots get a
 *   result that says it is unavailable;
 * - `vault-locked`: its secrets are in the vault, which is locked until the
 *   operator unlocks it.
 */
export const ConnectorStatus = Schema.Union([
  Schema.TaggedStruct("connected", {}),
  Schema.TaggedStruct("needs-sign-in", { reason: OpenLiterals(SIGN_IN_REASONS) }),
  Schema.TaggedStruct("failing", {
    reason: OpenLiterals(FAILURE_REASONS),
    since: Schema.DateTimeUtc,
  }),
  Schema.TaggedStruct("vault-locked", {}),
]);
export type ConnectorStatus = typeof ConnectorStatus.Type;

/**
 * A change to a connector's tools the operator has not accepted, which no bot
 * gets until they do: a tool it added, or one whose description or input
 * changed (`inputChanged` when what it takes changed, whatever its words
 * say). A tool the connector took away goes at once, and is never held.
 */
export const HeldToolChange = Schema.Union([
  Schema.TaggedStruct("added", { tool: ConnectorTool }),
  Schema.TaggedStruct("changed", {
    tool: ConnectorTool,
    previous: ConnectorTool,
    inputChanged: Schema.Boolean,
  }),
]);
export type HeldToolChange = typeof HeldToolChange.Type;

/** Which held changes the operator saw, so accepting them never covers one that came after. */
export const ToolReviewRevision = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("ToolReviewRevision"));
export type ToolReviewRevision = typeof ToolReviewRevision.Type;

export const ToolReview = Schema.Struct({
  revision: ToolReviewRevision,
  changes: Schema.NonEmptyArray(HeldToolChange),
});
export type ToolReview = typeof ToolReview.Type;

/** How bots reach a connector: at its address, or through the command the server starts. */
export const ConnectorTransport = Schema.Union([
  Schema.TaggedStruct("remote", { url: ConnectorUrl }),
  Schema.TaggedStruct("command", ConnectorCommand.fields),
]);
export type ConnectorTransport = typeof ConnectorTransport.Type;

/**
 * How the connector signs in, which says what "Sign in again" opens: the
 * browser (`oauth`), the form that takes its token or key again (`fields`),
 * or nothing (`none`).
 */
export const ConnectorSignIn = Schema.Literals(["oauth", "fields", "none"]);
export type ConnectorSignIn = typeof ConnectorSignIn.Type;

/** A connector the operator added, as every client sees it. It carries none of its secrets. */
export const Connector = Schema.Struct({
  id: ConnectorId,
  name: Label,
  glyph: Schema.NullOr(ConnectorGlyph),
  publisher: ConnectorPublisher,
  /** The gallery entry it was added from; null for one added by address or by command. */
  listing: Schema.NullOr(ListingRef),
  transport: ConnectorTransport,
  signIn: ConnectorSignIn,
  /** The fields its form took, without their values, for giving them again. */
  fields: Schema.Array(ConnectorField).check(Schema.isMaxLength(32)),
  status: ConnectorStatus,
  grant: ConnectorGrant,
  /** The account it is signed in as, when the service says. */
  account: Schema.NullOr(Label),
  /** When the operator last signed in, or gave its token; null before. */
  signedInAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The tools bots may use: those the operator accepted that the connector still offers. */
  tools: Schema.Array(ConnectorTool),
  /** Changes to its tools that wait on the operator, and that no bot gets until then. */
  review: Schema.NullOr(ToolReview),
  createdAt: Schema.DateTimeUtc,
});
export type Connector = typeof Connector.Type;

/**
 * A value of `max` characters at most with no line break or NUL, redacted as
 * soon as it is decoded and checked only then, so neither a refused value nor
 * a log of the request prints it. A line break would let a header value
 * start another header.
 */
const secretValue = (min: number, max: number) =>
  Schema.Redacted(Schema.String).check(
    Schema.makeFilter(
      (value: Redacted.Redacted<string>) => {
        const text = Redacted.value(value);
        return text.length >= min && text.length <= max && !/[\r\n\0]/.test(text);
      },
      { expected: `a value of ${min} to ${max} characters on one line` },
    ),
  );

/** What the operator typed in one field of a connect form. Every value is redacted, the plain ones too. */
export const ConnectorFieldValue = Schema.Struct({
  key: FieldKey,
  value: secretValue(0, 10_000),
});
export type ConnectorFieldValue = typeof ConnectorFieldValue.Type;

export const ConnectorFieldValues = Schema.Array(ConnectorFieldValue).check(Schema.isMaxLength(32));

/** A header's name, as HTTP allows one: a token, so it cannot carry a line break. */
export const HeaderName = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/),
).pipe(Schema.brand("HeaderName"));
export type HeaderName = typeof HeaderName.Type;

/** A header the server adds to every request to a connector added by address. */
export const ConnectorHeader = Schema.Struct({ name: HeaderName, value: secretValue(0, 10_000) });
export type ConnectorHeader = typeof ConnectorHeader.Type;

/** An environment variable's name, for a server started by command. */
export const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).pipe(
  Schema.brand("EnvName"),
);
export type EnvName = typeof EnvName.Type;

/**
 * An OAuth client the operator registered at the service and pastes: its id,
 * and its secret when the service gave one.
 */
export const OAuthClientInput = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  clientSecret: Schema.NullOr(secretValue(1, 2_000)),
});
export type OAuthClientInput = typeof OAuthClientInput.Type;

/**
 * What a connector is added from:
 * - `listing`: a gallery entry, with the values its form asked for, and the
 *   operator's OAuth client for an `own-app` one;
 * - `remote`: an address the operator typed, with any headers and an
 *   optional OAuth client. `privateNetwork` says the operator confirmed an
 *   address in their own network; without it the server refuses one;
 * - `command`: a command the operator confirmed, which runs on the server as
 *   its user, with its environment. Offered by the web and desktop apps only.
 */
export const ConnectorSource = Schema.Union([
  Schema.TaggedStruct("listing", {
    ref: ListingRef,
    values: ConnectorFieldValues,
    oauthClient: Schema.NullOr(OAuthClientInput),
  }),
  Schema.TaggedStruct("remote", {
    name: Label,
    url: ConnectorUrl,
    headers: Schema.Array(ConnectorHeader).check(Schema.isMaxLength(32)),
    oauthClient: Schema.NullOr(OAuthClientInput),
    privateNetwork: Schema.Boolean,
  }),
  Schema.TaggedStruct("command", {
    name: Label,
    command: ConnectorCommand.fields.command,
    args: ConnectorCommand.fields.args,
    env: Schema.Array(Schema.Struct({ name: EnvName, value: secretValue(0, 10_000) })).check(
      Schema.isMaxLength(64),
    ),
  }),
]);
export type ConnectorSource = typeof ConnectorSource.Type;

/**
 * Where the browser returns to J3 Bots after the operator signs in:
 * - `server`: the server's own address, when it is `https:` or the desktop
 *   app runs it on its own computer;
 * - `relay`: the device that asked listens on `http://127.0.0.1:<port>` for
 *   this one sign-in, and sends the address it caught with
 *   `connector.completeSignIn`;
 * - `paste`: the browser lands on a page no one answers, and the operator
 *   pastes its address into the app, which sends it the same way.
 */
export const SignInRedirect = Schema.Union([
  Schema.TaggedStruct("server", {}),
  Schema.TaggedStruct("relay", {
    port: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 })),
  }),
  Schema.TaggedStruct("paste", {}),
]);
export type SignInRedirect = typeof SignInRedirect.Type;

/**
 * A sign-in under way, which the device that began it opens in the system
 * browser. Only that device can finish it, until `expiresAt`. The address
 * carries the sign-in's `state`, so it is redacted like the rest.
 */
export const SignInStarted = Schema.Struct({
  authorizationUrl: Schema.Redacted(Schema.String.check(Schema.isMaxLength(8_000))),
  expiresAt: Schema.DateTimeUtc,
});
export type SignInStarted = typeof SignInStarted.Type;

/** The address the browser returned to, which carries the sign-in's code. */
export const SignInCallback = secretValue(1, 8_000);
