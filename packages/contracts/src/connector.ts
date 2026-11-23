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

/**
 * Whether `text` is an `https:` address of at most `max` characters, with no
 * space or control character anywhere: the URL parser drops tabs and line
 * breaks, and trims spaces, so text holding one would not be the address it
 * parses as. With `bare`, also with no user name, password or fragment.
 */
const isHttpsAddress = (text: string, max: number, bare: boolean): boolean =>
  text.length <= max &&
  !/[\x00-\x20\x7f]/.test(text) &&
  Option.exists(
    parseUrl(text),
    (url) =>
      url.protocol === "https:" &&
      (!bare || (url.username === "" && url.password === "" && url.hash === "")),
  );

const BARE_HTTPS = "an https: address with no user name, fragment, space or control character";

/** A page the operator opens to set a connector up, such as where to make a token. */
export const SetupPageUrl = Schema.String.check(
  Schema.makeFilter(
    (text: string) => isHttpsAddress(text, MAX_CONNECTOR_URL_LENGTH, true) || BARE_HTTPS,
  ),
).pipe(Schema.brand("SetupPageUrl"));
export type SetupPageUrl = typeof SetupPageUrl.Type;

/**
 * A text that may carry a secret, redacted as soon as it is decoded and checked
 * only then, so neither a refused value nor a log of the request prints it.
 */
const redactedText = (isValid: (text: string) => boolean, expected: string) =>
  Schema.Redacted(Schema.String).check(
    Schema.makeFilter((value: Redacted.Redacted<string>) => isValid(Redacted.value(value)), {
      expected,
    }),
  );

/**
 * Where a remote connector the operator adds by address answers: an `https:`
 * address with no user name, password or fragment. Its path or query can
 * carry a key, as some services hand out, so it travels redacted and the
 * server keeps it with the connector's secrets; clients are shown only its
 * origin (`ConnectorTransport`). Whether its host may be reached at all (an
 * address in the operator's own network, after DNS) is the server's to check
 * when it connects.
 */
export const ConnectorAddress = redactedText(
  (text) => isHttpsAddress(text, MAX_CONNECTOR_URL_LENGTH, true),
  BARE_HTTPS,
);
export type ConnectorAddress = typeof ConnectorAddress.Type;

/** An `https:` origin: scheme, host and port, nothing more. What a client is shown of a remote connector's address. */
export const ConnectorOrigin = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      Option.exists(parseUrl(text), (url) => url.protocol === "https:" && url.origin === text) ||
      "an https: origin",
  ),
).pipe(Schema.brand("ConnectorOrigin"));
export type ConnectorOrigin = typeof ConnectorOrigin.Type;

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

/** The most choices a connect form's field offers. */
export const MAX_FIELD_CHOICES = 32;

/**
 * One field the connect form asks for. A `secret` field is masked, and its
 * value is never shown again. A field with `choices` takes one of them and
 * nothing else; one without takes any text.
 */
export const ConnectorField = Schema.Struct({
  key: FieldKey,
  label: Label,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
  secret: Schema.Boolean,
  required: Schema.Boolean,
  placeholder: Schema.NullOr(Label),
  choices: Schema.Array(Label).check(Schema.isMaxLength(MAX_FIELD_CHOICES)),
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

const noNul = Schema.makeFilter((text: string) => !text.includes("\0") || "no NUL character");

/**
 * The program a command connector runs, as the operator or the registry gave
 * it: a name the system looks up, or a path. A command line cannot hold NUL.
 */
export const Program = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000), noNul);

/**
 * A gallery entry's server started by command on J3 Bots' machine, as its
 * user: the command line its registry entry gives, which the operator confirms
 * before it runs, and the names of the environment variables it takes, never
 * their values.
 */
export const ConnectorCommand = Schema.Struct({
  command: Program,
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000), noNul)).check(
    Schema.isMaxLength(64),
  ),
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
 * say). A changed tool cannot be kept as it was, since its server answers only
 * as it now is: while its change is held, no bot gets the tool at all. A tool
 * the connector took away goes at once, and is never held.
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

/**
 * The held changes of a connector's tools, at a revision. `kept`: the operator
 * answered `keep`, so the changes stay held, with no badge, until they accept
 * them from the connector's page or the tools change again, which makes a new
 * revision that waits on them as any does.
 */
export const ToolReview = Schema.Struct({
  revision: ToolReviewRevision,
  changes: Schema.NonEmptyArray(HeldToolChange),
  kept: Schema.Boolean,
});
export type ToolReview = typeof ToolReview.Type;

/**
 * What a client is shown of how bots reach a connector: the origin of its
 * address, or the program the server starts. Never the whole address, nor the
 * command's arguments, either of which can carry a key: the server keeps those
 * with the connector's secrets (`displayTransport`).
 */
export const ConnectorTransport = Schema.Union([
  Schema.TaggedStruct("remote", { origin: ConnectorOrigin }),
  Schema.TaggedStruct("command", { program: Program }),
]);
export type ConnectorTransport = typeof ConnectorTransport.Type;

/** What a client is shown of a connector at `url`: its origin. */
export const remoteTransport = (url: URL): ConnectorTransport => ({
  _tag: "remote",
  origin: ConnectorOrigin.make(url.origin),
});

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
 * A secret of `min` to `max` characters with no line break or NUL, redacted
 * (`redactedText`). A line break would let a header value start another
 * header.
 */
const secretValue = (min: number, max: number) =>
  redactedText(
    (text) => text.length >= min && text.length <= max && !/[\r\n\0]/.test(text),
    `a value of ${min} to ${max} characters on one line`,
  );

/** An argument of a command the operator gives, redacted, as one can carry a key. */
const CommandArgument = redactedText(
  (text) => text.length <= 4_000 && !text.includes("\0"),
  "an argument of at most 4000 characters with no NUL",
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
 * An OAuth client the operator registered at the service and pastes: the
 * authorization server it is registered at (its issuer, as the service
 * documents it, such as `https://accounts.google.com`), its id, and its
 * secret when the service gave one. The server uses it with that issuer
 * only, so a connector that names another never gets its secret.
 */
export const OAuthClientInput = Schema.Struct({
  issuer: Schema.String.check(
    Schema.makeFilter(
      (text: string) => isHttpsAddress(text, MAX_CONNECTOR_URL_LENGTH, true) || BARE_HTTPS,
    ),
  ),
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
 *   A secret goes in `env`, which is masked as it is typed; the arguments are
 *   redacted and kept with the secrets all the same, in case one carries a key.
 */
export const ConnectorSource = Schema.Union([
  Schema.TaggedStruct("listing", {
    ref: ListingRef,
    values: ConnectorFieldValues,
    oauthClient: Schema.NullOr(OAuthClientInput),
  }),
  Schema.TaggedStruct("remote", {
    name: Label,
    url: ConnectorAddress,
    headers: Schema.Array(ConnectorHeader).check(Schema.isMaxLength(32)),
    oauthClient: Schema.NullOr(OAuthClientInput),
    privateNetwork: Schema.Boolean,
  }),
  Schema.TaggedStruct("command", {
    name: Label,
    command: Program,
    args: Schema.Array(CommandArgument).check(Schema.isMaxLength(64)),
    env: Schema.Array(Schema.Struct({ name: EnvName, value: secretValue(0, 10_000) })).check(
      Schema.isMaxLength(64),
    ),
  }),
]);
export type ConnectorSource = typeof ConnectorSource.Type;

/**
 * What a client is shown of how a connector added by address or by command is
 * reached: the address's origin, or the program alone. The server words every
 * connector it sends with this, or `remoteTransport` for a gallery entry's.
 */
export const displayTransport = (
  source: Extract<ConnectorSource, { readonly _tag: "remote" | "command" }>,
): ConnectorTransport =>
  source._tag === "command"
    ? { _tag: "command", program: source.command }
    : remoteTransport(new URL(Redacted.value(source.url)));

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
 * carries the sign-in's `state`, so it is redacted like the rest, and checked
 * only once redacted: a client opens nothing but an `https:` address.
 */
export const SignInStarted = Schema.Struct({
  authorizationUrl: redactedText(
    (text) => isHttpsAddress(text, 8_000, false),
    "an https: address of at most 8000 characters with no space or control character",
  ),
  expiresAt: Schema.DateTimeUtc,
});
export type SignInStarted = typeof SignInStarted.Type;

/** The address the browser returned to, which carries the sign-in's code. */
export const SignInCallback = secretValue(1, 8_000);
