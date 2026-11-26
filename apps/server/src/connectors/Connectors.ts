// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A command connector runs in the home folder, and how many may run depends on the memory, which node:os gives.
import * as NodeOs from "node:os";
import {
  type Activity,
  type CallHooks,
  type CallProgress,
  type AppDocument,
  appDocumentOf,
  toolUiOf,
  type CatalogTool,
  checkUrl,
  type ConnectorFailure,
  DEFAULT_SESSION_LIMITS,
  makeSupervisor,
  MAX_APP_RESOURCE_JSON_BYTES,
  type McpSession,
  NeedsSignIn,
  nextFailing,
  type Observation,
  observe,
  openCommandSession,
  openSession,
  processCapacity,
  type Prompt,
  type PromptText,
  type ResourceRead,
  resourceText,
  type ResponseCache,
  responseCache,
  type SecretHeader,
  type SessionLimits,
  toolName,
  type UrlPolicy,
  Withdrawn,
} from "@j3-bots/connectors";
import {
  BotId,
  type ChangeAuthor,
  type CommandError,
  type CommandLine,
  type CommandId,
  Conflict,
  Connector,
  type ConnectorAppAnswer,
  type ConnectorAppTool,
  MAX_CONNECTOR_APP_DATA_BYTES,
  type ConnectorField,
  type ConnectorFieldValue,
  type ConnectorGlyph,
  type ConnectorGrant,
  type ConnectorId,
  type ConnectorPublisher,
  type ConnectorSignIn,
  type ConnectorSource,
  type ConnectorsEvent,
  displayTransport,
  type ConnectorTransport,
  FieldKey,
  Invalid,
  type ListingRef,
  NotFound,
  type OAuthClientInput,
  pinRefusal,
  remoteTransport,
  reservedVariable,
  type ConnectorPrompt,
  type Elicitation,
  type ElicitationAnswer,
  type PromptArguments,
} from "@j3-bots/contracts";
import {
  CONNECTOR_UNAVAILABLE,
  type ConnectorResult,
  type ConnectorUnavailable,
  connectorToolDescription,
  type ListedPrompt,
  type ListedResource,
  listingText,
  NOTHING_LISTED,
  renderConnectorResult,
} from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import packageJson from "../../package.json" with { type: "json" };
import { BotStore } from "../bots/BotStore.ts";
import { Workspaces } from "../bots/Workspaces.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { keyedLock } from "../turns/keyedLock.ts";
import type { ConnectorSecret, NamedSecret } from "../secrets/ConnectorSecret.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { ConnectorSignIns, type SignInState } from "./auth.ts";
import { ConnectorStore, type PendingRemoval, type StoredConnector } from "./ConnectorStore.ts";
import {
  addressOf,
  commandOf,
  credentialsOf,
  hiddenOf,
  connectorSecretIdOf,
} from "./credentials.ts";
import { makeListings } from "./listings.ts";
import { headerFieldKeys, refill, resolve } from "./sources/form.ts";
import { ConnectorSources } from "./sources/Sources.ts";
import { connectorOf, NOTHING_SEEN, offeredOf, type Seen, statusOfConnector } from "./view.ts";

/**
 * The operator's connectors (`docs/architecture/server.md`, "Connectors"):
 * what the connector requests do, the tools each bot is offered, and the
 * calls bots make to them.
 */

/** A connector's tool as a bot is offered it, through the `j3` bridge. */
export interface OfferedTool {
  /** `<slug>__<tool>`: at most 55 characters of `[A-Za-z0-9_-]`, with exactly one `__`. */
  readonly name: string;
  readonly connectorId: ConnectorId;
  /** Its name at the connector's server. */
  readonly upstreamName: string;
  /** As its server listed it, cleaned and capped, after J3 Bots' line saying whose it is. */
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
}

/** A connector, as a call's hooks and a bot's listings name it. */
export interface ConnectorRef {
  readonly id: ConnectorId;
  readonly name: string;
  readonly glyph: ConnectorGlyph | null;
  /** The prefix of its tools' names, by which a bot names it. */
  readonly slug: string;
}

/**
 * What one bot's call to a connector reaches while it runs: its work step,
 * and the operator, when the connector's server asks for something.
 */
export interface ConnectorCallHooks {
  /** The call to `tool` is about to go out; `ui` is the tool's `_meta.ui`, for MCP Apps. */
  readonly started: (call: {
    readonly connector: ConnectorRef;
    readonly ui: Schema.JsonObject | null;
  }) => Effect.Effect<void>;
  readonly progress: (progress: CallProgress) => Effect.Effect<void>;
  /** Shows the server's request to the operator, in the bot's conversation, and waits for the answer. */
  readonly ask: (connector: ConnectorRef, request: Elicitation) => Effect.Effect<ElicitationAnswer>;
}

/** What one connector lists of a kind, with whose it is. */
interface Listed<A> {
  readonly connector: ConnectorRef;
  readonly items: ReadonlyArray<A>;
}

/** Why J3 Bots got no answer from a connector, as the bot or the operator is told. */
class ConnectorUnavailableError extends Schema.TaggedError<ConnectorUnavailableError>()(
  "ConnectorUnavailableError",
  { reason: Schema.Literals(CONNECTOR_UNAVAILABLE) },
) {}

/**
 * An app a connector's tool opened (the MCP Apps extension, decision 0048):
 * the tool, its document as its server gave it, and the call's answer as MCP
 * gives it, with the connector's secrets taken out (null when too large).
 */
export interface OpenedApp {
  readonly connectorId: ConnectorId;
  readonly connector: string;
  readonly tool: ConnectorAppTool;
  readonly document: AppDocument;
  readonly result: Schema.Json | null;
}

/** What a bot reads back from a connector's tool: framed as untrusted data, or J3 Bots' own line when there was no answer. */
export interface ToolCallAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** A tool call's answer, and the app the tool opened, when it has one and its server answered both. */
export interface CalledTool extends ToolCallAnswer {
  readonly app: Option.Option<OpenedApp>;
}

/** The bot is offered no tool by that name, or no connector by that slug: none such, or not granted. */
export class ToolNotOffered extends Schema.TaggedError<ToolNotOffered>()("ToolNotOffered", {}) {
  override get message(): string {
    return "No connector tool by that name is offered to this bot.";
  }
}

export class Connectors extends Context.Service<
  Connectors,
  {
    /** The tools `botId` is offered now: those of granted connectors that are connected. */
    readonly toolsFor: (botId: BotId) => Effect.Effect<ReadonlyArray<OfferedTool>>;
    /** Each bot whose offered tools may have changed, from the moment of subscribing. */
    readonly toolsChanged: Stream.Stream<BotId>;
    /**
     * Calls the tool for `botId`. A connector that can't answer gives the
     * bot J3 Bots' own line, as an error result, not a failure.
     * Interrupting the call cancels it at the connector's server.
     */
    readonly call: (input: {
      readonly botId: BotId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly hooks?: ConnectorCallHooks;
    }) => Effect.Effect<CalledTool, ToolNotOffered>;
    /**
     * The resources and resource templates of the connectors `botId` may use
     * that are connected, or of the one `slug` names, as their servers list
     * them now, those that hold every word of `search`; framed for the bot,
     * one block per connector. A connector that could not list them is left out.
     */
    readonly resources: (input: {
      readonly botId: BotId;
      readonly slug?: string;
      readonly search?: string;
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    /** Reads one resource of the connector `slug` names, for `botId`, framed for the bot. */
    readonly readResource: (input: {
      readonly botId: BotId;
      readonly slug: string;
      readonly uri: string;
      readonly hooks?: Pick<ConnectorCallHooks, "ask">;
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    /** As {@link resources}, of prompts. */
    readonly prompts: (input: {
      readonly botId: BotId;
      readonly slug?: string;
      readonly search?: string;
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    /** One prompt of the connector `slug` names, as its server writes it, for `botId`, framed for the bot. */
    readonly getPrompt: (input: {
      readonly botId: BotId;
      readonly slug: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, string>>;
      readonly hooks?: Pick<ConnectorCallHooks, "ask">;
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    /** The prompts of the connectors `botId` may use, for the operator's `/` menu in its conversation. */
    readonly menuPrompts: (
      botId: BotId,
    ) => Effect.Effect<ReadonlyArray<ConnectorPrompt>, CommandError>;
    /** Renders a prompt the operator chose from the `/` menu, as text for their composer. */
    readonly renderPrompt: (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: PromptArguments;
    }) => Effect.Effect<{ readonly text: string; readonly cut: boolean }, CommandError>;
    /**
     * A tool call an app asked for, as `botId`, through that bot's own
     * session: a tool of the connector's that the bot may use and whose
     * `visibility` includes `app`, checked as the bot's own calls are, and
     * made only while `permitted` holds once the session is open.
     */
    readonly appCall: (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly permitted: Effect.Effect<boolean>;
    }) => Effect.Effect<ConnectorAppAnswer>;
    /** A resource an app asked to read, as `botId`, through that bot's own session. */
    readonly appRead: (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly uri: string;
    }) => Effect.Effect<ConnectorAppAnswer>;
    readonly subscribe: Stream.Stream<ConnectorsEvent>;
    /** Every connector, as clients see it, with the prefix its tools are named under (`<prefix>__<tool>`). */
    readonly listed: Effect.Effect<ReadonlyArray<ListedConnector>>;
    /** Adds a connector for `grant`, every bot when it is left out, recorded as `by`'s change. */
    readonly add: (input: {
      readonly id: ConnectorId;
      readonly source: ConnectorSource;
      /** Which bots get it; every bot when left out. */
      readonly grant?: ConnectorGrant;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Connector, CommandError>;
    readonly update: (input: {
      readonly connectorId: ConnectorId;
      readonly name?: string;
      readonly values?: ReadonlyArray<ConnectorFieldValue>;
      readonly command?: CommandLine;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Connector, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
    }) => Effect.Effect<void, CommandError>;
    readonly setBots: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly grant: ConnectorGrant;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Connector, CommandError>;
  }
>()("@j3-bots/server/connectors/Connectors") {}

/** A connector as a bot's `list_mcp_servers` names it: as clients see it, and its tools' prefix. */
export interface ListedConnector {
  readonly connector: Connector;
  readonly prefix: string;
}

/** A connector's change, as subscribers are told it. */
interface Change {
  readonly _tag: "upsert" | "remove";
  readonly id: ConnectorId;
}
const changeOf = (tag: Change["_tag"], id: ConnectorId): Change => ({ _tag: tag, id });

/** Whose session it is: a bot's, or the one the server lists a connector's tools with. */
type Holder = BotId | "catalog";

/** A session of a connector that is no longer there, or no longer the bot's. */
class ConnectorGone extends Schema.TaggedError<ConnectorGone>()("ConnectorGone", {}) {}
const isGone = Schema.is(ConnectorGone);

/** A failure, and whether it came while opening the session or during the call. */
interface Stumble {
  readonly activity: Activity;
  readonly failure: ConnectorFailure;
}

/** A session closes after this long unused. */
const IDLE_CLOSE = Duration.minutes(10);

/** The most sessions open at once, idle ones included, across every connector and bot. */
const MAX_SESSIONS = 32;

const CLIENT = { name: "j3-bots", version: packageJson.version };

const SEPARATOR = "/";
const sessionKey = (id: ConnectorId, holder: Holder) => `${id}${SEPARATOR}${holder}`;
const decodeConnectorId = Schema.decodeUnknownOption(Connector.fields.id);
const decodeBotId = Schema.decodeUnknownOption(BotId);

/** How this server reaches connectors' servers. */
interface ConnectorReachSettings {
  readonly limits: SessionLimits;
  /**
   * `refuse`: a remote connector answers at an `https:` address outside this
   * machine. Only a test's fake server, on loopback, is reached otherwise.
   */
  readonly loopback: UrlPolicy["loopback"];
}

/** Production's limits and policy, which a test replaces to reach its fake server. */
export class ConnectorReach extends Context.Reference<ConnectorReachSettings>(
  "@j3-bots/server/connectors/ConnectorReach",
  { defaultValue: () => ({ limits: DEFAULT_SESSION_LIMITS, loopback: "refuse" }) },
) {}

/** How this server runs command connectors' processes. */
interface CommandReachSettings {
  readonly platform: NodeJS.Platform;
  /** The server's environment, of which a command gets only a few variables (`commandEnvironment`). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The folder a command runs in: the home folder of the server's user. */
  readonly cwd: string;
  /** How many may run at once: on a small computer, such as a Raspberry Pi, only a few. */
  readonly capacity: number;
  /** A process stops after this long unused. */
  readonly idle: Duration.Duration;
  readonly backoff: {
    readonly initial: Duration.Duration;
    readonly max: Duration.Duration;
    readonly stable: Duration.Duration;
  };
  /** How many times in a row a process may end by itself and still be started again without a use. */
  readonly restarts: number;
}

/** Production's settings, which a test replaces to give the server an environment of its own and shorter waits. */
export class CommandReach extends Context.Reference<CommandReachSettings>(
  "@j3-bots/server/connectors/CommandReach",
  {
    defaultValue: () => ({
      platform: process.platform,
      environment: process.env,
      cwd: NodeOs.homedir(),
      capacity: processCapacity(NodeOs.totalmem()),
      idle: IDLE_CLOSE,
      backoff: {
        initial: Duration.seconds(1),
        max: Duration.minutes(1),
        stable: Duration.minutes(1),
      },
      restarts: 5,
    }),
  },
) {}

const isCommand = (connector: StoredConnector) => connector.transport._tag === "command";

/** The fields a command's environment becomes: each value is asked for again, never shown. */
const envFieldsOf = (command: CommandLine): ReadonlyArray<ConnectorField> =>
  command.env.map((variable) => ({
    key: FieldKey.make(variable.name),
    label: variable.name,
    description: null,
    secret: true,
    required: false,
    placeholder: null,
    choices: [],
  }));

/**
 * Whether the server takes a command line: every package it runs through
 * `npx` or `uvx` at an exact version, and no variable named twice, in any
 * case, since Windows reads names without it, or by a name the server reads
 * to find and start the program.
 */
const checkCommand = (command: CommandLine): Effect.Effect<void, Invalid> => {
  const given = command.env.map((variable) => variable.name);
  if (Option.isSome(pinRefusal(command.command, command.args.map(Redacted.value), given))) {
    return Effect.fail(new Invalid({ reason: "command-unpinned" }));
  }
  const names = given.map((name) => name.toUpperCase());
  return new Set(names).size === names.length && !given.some(reservedVariable)
    ? Effect.void
    : Effect.fail(new Invalid({ reason: "connector-fields" }));
};

/** What the bot is told when a connector gave no answer; a withdrawn call is not one it may make. */
const unavailableOf = (failure: Exclude<ConnectorFailure, Withdrawn>): ConnectorUnavailable => {
  switch (failure._tag) {
    case "NeedsSignIn":
      return "needs-sign-in";
    case "AuthFailing":
      return failure.reason === "secret-unusable" ? "needs-sign-in" : "unreachable";
    case "SecretsUnavailable":
      return "secrets-unavailable";
    case "TimedOut":
      return "timed-out";
    case "ResponseTooLarge":
      return "too-large";
    case "UrlRefused":
    case "Unreachable":
      return "unreachable";
    case "ServerError":
    case "NotMcp":
      return "failed";
    case "CommandFailed":
      return "unreachable";
  }
};

/** A failure after which the session is not used again: the next call opens another. */
const breaksSession = (failure: ConnectorFailure) =>
  failure._tag === "Unreachable" || failure._tag === "NotMcp" || failure._tag === "ServerError";

/**
 * A failure after which a command connector's process is stopped: the next
 * call starts another. One that ended by itself is the supervisor's to see.
 */
const breaksProcess = (failure: ConnectorFailure) =>
  breaksSession(failure) || failure._tag === "ResponseTooLarge";

/** The fingerprint of a set of tools: names and digests, to tell whether what bots get changed. */
const fingerprint = (tools: ReadonlyArray<CatalogTool>) =>
  tools.map((tool) => `${tool.name}:${tool.digest}`).join("\n");

/** The field a header the operator gave becomes: its value is asked for again when the service refuses it. */
const fieldOf = (header: SecretHeader): ConnectorField => ({
  key: FieldKey.make(header.name),
  label: header.name,
  description: null,
  secret: true,
  required: true,
  placeholder: null,
  choices: [],
});

/** Whether a connector's sign-in is as it was: a change is told to subscribers. */
const sameSignIn = (a: SignInState, b: SignInState): boolean => {
  switch (a._tag) {
    case "signed-in":
      return (
        b._tag === "signed-in" &&
        a.account === b.account &&
        DateTime.Equivalence(a.signedInAt, b.signedInAt)
      );
    case "needs-sign-in":
      return b._tag === "needs-sign-in" && a.reason === b.reason;
    case "failing":
      return b._tag === "failing" && a.reason === b.reason;
    case "secrets-unavailable":
      return b._tag === "secrets-unavailable";
  }
};

/**
 * A connector's source, made ready to add: where its server is, what each
 * request sends, how clients see it, and how it signs in once the server's
 * first answer, or its failure, is known.
 */
interface Prepared {
  readonly name: string;
  readonly glyph: ConnectorGlyph | null;
  readonly publisher: ConnectorPublisher;
  readonly listing: ListingRef | null;
  /** Sealed in the secrets: a key can be part of it. */
  readonly url: Redacted.Redacted<string>;
  readonly transport: ConnectorTransport;
  readonly headers: ReadonlyArray<SecretHeader>;
  /** The fields asked for again when the service refuses what was sent, for a connector that signs in with `fields`. */
  readonly fields: ReadonlyArray<ConnectorField>;
  /** A gallery entry's secret values, by field key, as the secrets keep them. */
  readonly formSecrets: ReadonlyArray<NamedSecret>;
  readonly oauthClient: OAuthClientInput | null;
  readonly privateNetwork: boolean;
  readonly signIn: (
    probe: Result.Result<ReadonlyArray<CatalogTool>, ConnectorFailure>,
  ) => ConnectorSignIn;
}

const refOf = (connector: StoredConnector): ConnectorRef => ({
  id: connector.id,
  name: connector.name,
  glyph: connector.glyph,
  slug: connector.slug,
});

export const layer = Layer.effect(
  Connectors,
  Effect.gen(function* () {
    const store = yield* ConnectorStore;
    const secrets = yield* Secrets;
    const signIns = yield* ConnectorSignIns;
    const bots = yield* BotStore;
    const workspaces = yield* Workspaces;
    const receipts = yield* CommandReceipts;
    const random = yield* SecureRandom.SecureRandom;
    const reach = yield* ConnectorReach;
    const sources = yield* ConnectorSources;
    const commandReach = yield* CommandReach;
    const policyOf = (privateNetwork: boolean): UrlPolicy => ({
      loopback: reach.loopback,
      privateNetwork: privateNetwork ? "allow" : "refuse",
      redirects: "recheck",
    });

    const seenRef = yield* Ref.make<ReadonlyMap<ConnectorId, Seen>>(new Map());
    const secretsUnavailable = yield* Ref.make(true);
    const signInStates = yield* Ref.make<ReadonlyMap<ConnectorId, SignInState>>(new Map());
    const changes = yield* PubSub.unbounded<Change>();
    const toolChanges = yield* PubSub.unbounded<BotId>();
    const scope = yield* Effect.scope;
    /** Lists connectors in the background, one listing of each at a time. */
    const inFlight = yield* makeListings<ConnectorId>(scope);

    /**
     * Each connector's response cache, shared by its sessions, which are all
     * signed alike. It goes with the connector's sessions, whenever what they
     * are signed with may change.
     */
    const caches = yield* Ref.make<ReadonlyMap<ConnectorId, ResponseCache>>(new Map());
    const cacheOf = (id: ConnectorId) =>
      Ref.modify(caches, (all): [ResponseCache, ReadonlyMap<ConnectorId, ResponseCache>] => {
        const kept = all.get(id);
        if (kept !== undefined) return [kept, all];
        const made = responseCache();
        return [made, new Map(all).set(id, made)];
      });
    const dropCache = (id: ConnectorId) =>
      Ref.update(caches, (all) => {
        const next = new Map(all);
        next.delete(id);
        return next;
      });

    const seenOf = (id: ConnectorId) =>
      Effect.map(Ref.get(seenRef), (seen) => seen.get(id) ?? NOTHING_SEEN);
    const updateSeen = (id: ConnectorId, f: (seen: Seen) => Seen) =>
      Ref.update(seenRef, (seen) => new Map(seen).set(id, f(seen.get(id) ?? NOTHING_SEEN)));

    const render = Effect.fn("Connectors.render")(function* (connector: StoredConnector) {
      const states = yield* Ref.get(signInStates);
      return connectorOf(
        connector,
        yield* seenOf(connector.id),
        yield* Ref.get(secretsUnavailable),
        Option.fromNullishOr(states.get(connector.id)),
      );
    });

    const require = Effect.fn("Connectors.require")(function* (id: ConnectorId) {
      const connector = yield* store.get(id);
      if (Option.isNone(connector)) return yield* new NotFound({ resource: "connector" });
      return connector.value;
    });

    const touch = (id: ConnectorId) => PubSub.publish(changes, changeOf("upsert", id));

    const botsOf = Effect.fn("Connectors.botsOf")(function* (connector: StoredConnector) {
      if (connector.grant._tag === "bots") return connector.grant.ids;
      return (yield* bots.list).map((stored) => stored.bot.id);
    });

    const toolsTouched = Effect.fn("Connectors.toolsTouched")(function* (ids: Iterable<BotId>) {
      for (const id of new Set(ids)) yield* PubSub.publish(toolChanges, id);
    });

    /**
     * Rewrites the instructions of bots that gained or lost a connector:
     * only a bot with one gets the connector rules.
     */
    const grantsChanged = Effect.fn("Connectors.grantsChanged")(function* (ids: Iterable<BotId>) {
      for (const id of new Set(ids)) yield* workspaces.render(id);
    });

    const offeredNow = Effect.fn("Connectors.offeredNow")(function* (id: ConnectorId) {
      const connector = yield* store.get(id);
      if (Option.isNone(connector)) return "";
      return fingerprint(offeredOf(connector.value, yield* seenOf(id)));
    });

    /**
     * One operator's change of a connector at a time: each reads its connector
     * record and writes it back whole, so two at once would lose one.
     */
    const perConnector = keyedLock();

    /** Runs `change`, then tells subscribers, and the connector's bots when what they get changed. */
    const changing = Effect.fn("Connectors.changing")(function* <A, E>(
      id: ConnectorId,
      change: Effect.Effect<A, E>,
    ) {
      const before = yield* offeredNow(id);
      const result = yield* change;
      if ((yield* offeredNow(id)) !== before) {
        const connector = yield* store.get(id);
        if (Option.isSome(connector)) yield* toolsTouched(yield* botsOf(connector.value));
      }
      yield* touch(id);
      return result;
    });

    /**
     * What the connector's server listed: the tools bots get, kept for after
     * a restart when they changed. A listing is an answer, signed as calls
     * are, so it clears a failure and a refusal.
     */
    const recordListing = (id: ConnectorId, catalog: ReadonlyArray<CatalogTool>) =>
      changing(
        id,
        Effect.gen(function* () {
          yield* updateSeen(id, (seen) => ({
            ...seen,
            listed: Option.some(catalog),
            failing: Option.none(),
            refused: false,
          }));
          const connector = yield* store.get(id);
          if (
            Option.isSome(connector) &&
            (connector.value.tools === null ||
              fingerprint(connector.value.tools) !== fingerprint(catalog))
          ) {
            yield* store.update(id, { tools: catalog }, yield* DateTime.now);
          }
        }),
      );

    /**
     * What the connector's server said of itself, and the resources and
     * prompts it lists now: none of a kind it does not offer, or could not
     * list, which the next listing tries again.
     */
    const recordServed = Effect.fn("Connectors.recordServed")(function* (
      id: ConnectorId,
      session: McpSession,
    ) {
      const listed = <A>(
        offered: boolean,
        list: Effect.Effect<ReadonlyArray<A>, ConnectorFailure>,
      ) =>
        offered ? list.pipe(Effect.orElseSucceed((): ReadonlyArray<A> => [])) : Effect.succeed([]);
      const resources = yield* listed(session.info.offers.resources, session.listResources);
      const prompts = yield* listed(session.info.offers.prompts, session.listPrompts);
      yield* updateSeen(id, (seen) => ({
        ...seen,
        served: Option.some({ info: session.info, resources, prompts }),
      }));
      yield* touch(id);
    });

    /**
     * The server said one of its lists changed: its tools, resources and
     * prompts are listed again, the one that changed from its server and the
     * others from the cache while it holds. However often it says so, one
     * listing at a time, and one more after it: each listing reads every list,
     * so the one after it misses none of the changes said meanwhile.
     */
    const listChanged = (id: ConnectorId, opened: Effect.Effect<McpSession, ConnectorGone>) => () =>
      inFlight(
        id,
        opened.pipe(
          Effect.flatMap((session) =>
            Effect.flatMap(session.listTools, (listed) => recordListing(id, listed)).pipe(
              Effect.andThen(recordServed(id, session)),
            ),
          ),
          Effect.ignore,
        ),
      );

    /** What an outcome says of the connector: an answer clears a failure, a failure is kept. */
    const record = Effect.fn("Connectors.record")(function* (
      id: ConnectorId,
      observation: Observation,
    ) {
      if (observation._tag === "unchanged") return;
      const now = yield* DateTime.now;
      const before = yield* seenOf(id);
      yield* updateSeen(id, (seen) => ({
        ...seen,
        failing: nextFailing(seen.failing, observation, now),
        refused:
          observation._tag === "needs-sign-in"
            ? true
            : observation._tag === "answered"
              ? false
              : seen.refused,
      }));
      const after = yield* seenOf(id);
      if (
        before.refused !== after.refused ||
        Option.isSome(before.failing) !== Option.isSome(after.failing)
      ) {
        yield* touch(id);
      }
    });

    /** Whether `holder` may still use the connector: the server's own session always, a bot's while it is granted. */
    const allowed = (id: ConnectorId, holder: Holder): Effect.Effect<boolean> =>
      holder === "catalog"
        ? Effect.succeed(true)
        : Effect.map(store.get(id), (connector) =>
            Option.exists(
              connector,
              (c) => c.grant._tag === "all-bots" || c.grant.ids.includes(holder),
            ),
          );

    const sessions = yield* RcMap.make({
      lookup: Effect.fn("Connectors.openSession")(function* (key: string) {
        const [rawId, rawHolder] = key.split(SEPARATOR);
        const id = decodeConnectorId(rawId);
        const holder = Option.fromNullishOr(rawHolder).pipe(
          Option.flatMap((raw) =>
            raw === "catalog" ? Option.some<Holder>("catalog") : decodeBotId(raw),
          ),
        );
        if (Option.isNone(id) || Option.isNone(holder)) return yield* new ConnectorGone();
        const connector = yield* store.get(id.value);
        if (Option.isNone(connector)) return yield* new ConnectorGone();
        const url = yield* addressOf(secrets, connector.value);
        const ready = yield* Deferred.make<McpSession, ConnectorGone>();
        const cache = yield* cacheOf(id.value);
        const session = yield* openSession({
          url,
          policy: policyOf(connector.value.privateNetwork),
          credentials: credentialsOf(
            secrets,
            signIns,
            connector.value,
            allowed(id.value, holder.value),
          ),
          limits: reach.limits,
          client: CLIENT,
          cache,
          onListChanged: listChanged(id.value, Deferred.await(ready)),
        }).pipe(Effect.tapError(() => Deferred.fail(ready, new ConnectorGone())));
        yield* Deferred.succeed(ready, session);
        yield* recordListing(id.value, yield* session.listTools);
        yield* recordServed(id.value, session);
        return session;
      }),
      idleTimeToLive: IDLE_CLOSE,
      capacity: MAX_SESSIONS,
    });

    /**
     * Starts a command connector's process and lists its tools. One the
     * operator removed, or turned into another kind, is withdrawn.
     */
    const startCommand = Effect.fn("Connectors.startCommand")(function* (id: ConnectorId) {
      const connector = yield* store.get(id);
      if (Option.isNone(connector) || connector.value.transport._tag !== "command") {
        return yield* new Withdrawn();
      }
      const command = yield* commandOf(secrets, connector.value);
      const ready = yield* Deferred.make<McpSession, ConnectorGone>();
      const cache = yield* cacheOf(id);
      const started = yield* openCommandSession({
        platform: commandReach.platform,
        program: command.program,
        args: command.args,
        variables: command.env,
        serverEnvironment: commandReach.environment,
        cwd: commandReach.cwd,
        limits: reach.limits,
        client: CLIENT,
        cache,
        onListChanged: listChanged(id, Deferred.await(ready)),
      }).pipe(Effect.tapError(() => Deferred.fail(ready, new ConnectorGone())));
      yield* Deferred.succeed(ready, started.session);
      yield* recordListing(id, yield* started.session.listTools);
      yield* recordServed(id, started.session);
      return started;
    });

    /** The command connectors' processes, one each, shared by every bot. */
    const processes = yield* makeSupervisor<ConnectorId>({
      start: startCommand,
      onFailure: (id, failure) => record(id, observe(failure, "connect")),
      idle: commandReach.idle,
      capacity: commandReach.capacity,
      backoff: commandReach.backoff,
      restarts: commandReach.restarts,
    });

    const closeSessions = Effect.fn("Connectors.closeSessions")(function* (
      id: ConnectorId,
      holder?: Holder,
    ) {
      // A command connector's one process serves every bot: it stops only for
      // the connector as a whole, which is also when its cache goes.
      if (holder === undefined) {
        yield* processes.stop(id);
        yield* dropCache(id);
      }
      for (const key of yield* RcMap.keys(sessions)) {
        const own =
          holder === undefined
            ? key.startsWith(`${id}${SEPARATOR}`)
            : key === sessionKey(id, holder);
        if (own) yield* RcMap.invalidate(sessions, key);
      }
    });

    /**
     * A session with the connector, for `holder`: a remote connector's own to
     * it, a command connector's process, shared. A session that failed to
     * open is not kept: `RcMap` would answer every later use with the same
     * failure until it went idle.
     */
    const openFor = (connector: StoredConnector, holder: Holder) =>
      isCommand(connector)
        ? processes.use(connector.id)
        : RcMap.get(sessions, sessionKey(connector.id, holder)).pipe(
            Effect.tapError(() => RcMap.invalidate(sessions, sessionKey(connector.id, holder))),
          );

    /** Lists the connector's tools again, through the server's own session. */
    const relist = (id: ConnectorId) =>
      Effect.scoped(
        Effect.flatMap(store.get(id), (connector) =>
          Option.isNone(connector)
            ? Effect.fail(new ConnectorGone())
            : openFor(connector.value, "catalog"),
        ),
      ).pipe(
        Effect.tapError((failure) =>
          failure._tag === "ConnectorGone" || failure._tag === "ExceededCapacityError"
            ? Effect.void
            : record(id, observe(failure, "connect")),
        ),
        Effect.ignore,
      );

    /**
     * Lists the tools of a connector this server has not seen listed since it
     * started, in the background: so it shows what it offers now, and a
     * connector that did not answer when it was added gets its tools. Asked again while a
     * listing runs, it tries once more after it if the connector is still not
     * listed, since what it was signed with may have changed since it began.
     *
     * A command connector listed before is not: listing would start its
     * process, which waits for a bot to use it. That start lists its tools,
     * before the call goes out.
     */
    const ensureListed = Effect.fn("Connectors.ensureListed")(function* (id: ConnectorId) {
      const unlisted = Effect.gen(function* () {
        const connector = yield* store.get(id);
        if (Option.exists(connector, (c) => isCommand(c) && c.tools !== null)) return false;
        return Option.isNone((yield* seenOf(id)).listed);
      });
      if (!(yield* unlisted)) return;
      yield* inFlight(
        id,
        Effect.gen(function* () {
          if (yield* unlisted) yield* relist(id);
        }),
        "while-unlisted",
      );
    });

    /**
     * Finishes a removal: revokes the sign-in, deletes the connector's
     * secret, and forgets the removal. While the secrets cannot be read it
     * waits until they can.
     */
    const finishRemoval = Effect.fn("Connectors.finishRemoval")(function* (
      removal: PendingRemoval,
    ) {
      if (removal.revoke) yield* signIns.disconnect(removal.id);
      yield* secrets.connectorSecrets.remove(connectorSecretIdOf(removal.id));
      yield* store.removalDone(removal.id);
    });

    const finishRemovals = Effect.fn("Connectors.finishRemovals")(function* () {
      for (const removal of yield* store.pendingRemovals) {
        yield* finishRemoval(removal).pipe(Effect.ignore);
      }
    });

    // The secrets' state: every connector keeps its address there, so is
    // "secrets unavailable" while they cannot be read, and is listed once they can.
    yield* Stream.runForEach(secrets.status, (status) =>
      Effect.gen(function* () {
        const unavailable = status.state !== "ready";
        if ((yield* Ref.getAndSet(secretsUnavailable, unavailable)) === unavailable) return;
        if (!unavailable) yield* finishRemovals();
        for (const connector of yield* store.all) {
          // A session opened, or failing to open, under the other state is not used again.
          yield* closeSessions(connector.id);
          yield* touch(connector.id);
          if (!unavailable) yield* ensureListed(connector.id);
        }
      }),
    ).pipe(Effect.forkScoped);

    // OAuth sign-ins: a new sign-in clears a refusal, and lists the tools of one never listed.
    yield* Stream.runForEach(signIns.states, (states) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(signInStates, states);
        const now = yield* DateTime.now;
        for (const [id, state] of states) {
          const before = previous.get(id);
          if (before !== undefined && sameSignIn(before, state)) continue;
          // Its sessions were signed for the sign-in as it was.
          yield* closeSessions(id);
          if (state._tag === "signed-in") {
            yield* updateSeen(id, (seen) => ({ ...seen, refused: false }));
            yield* ensureListed(id);
          }
          if (state._tag === "failing") {
            yield* updateSeen(id, (seen) => ({
              ...seen,
              failing: nextFailing(seen.failing, { _tag: "failing", reason: "unreachable" }, now),
            }));
          }
          yield* touch(id);
        }
      }),
    ).pipe(Effect.forkScoped);

    for (const connector of yield* store.all) yield* ensureListed(connector.id);

    const grantedTo = Effect.fn("Connectors.grantedTo")(function* (botId: BotId) {
      return (yield* store.all).filter(
        (connector) => connector.grant._tag === "all-bots" || connector.grant.ids.includes(botId),
      );
    });

    /** The connector's tools a bot is offered: accepted, still listed so, and not for apps alone. */
    const botToolsOf = (connector: StoredConnector, seen: Seen) =>
      offeredOf(connector, seen).filter((tool) => toolUiOf(tool.ui).model);

    const offeredTool = (connector: StoredConnector, seen: Seen, name: string) =>
      botToolsOf(connector, seen).find((tool) => toolName(connector.slug, tool.name) === name);

    const toolsFor = Effect.fn("Connectors.toolsFor")(function* (botId: BotId) {
      const granted = yield* grantedTo(botId);
      for (const connector of granted) yield* ensureListed(connector.id);
      const seen = yield* Ref.get(seenRef);
      const unavailable = yield* Ref.get(secretsUnavailable);
      const states = yield* Ref.get(signInStates);
      const connected = granted.filter(
        (connector) =>
          statusOfConnector(
            connector,
            seen.get(connector.id) ?? NOTHING_SEEN,
            unavailable,
            Option.fromNullishOr(states.get(connector.id)),
          )._tag === "connected",
      );
      return connected.flatMap((connector) =>
        botToolsOf(connector, seen.get(connector.id) ?? NOTHING_SEEN).map((tool): OfferedTool => ({
          name: toolName(connector.slug, tool.name),
          connectorId: connector.id,
          upstreamName: tool.name,
          description: connectorToolDescription(connector.name, tool.description),
          inputSchema: tool.inputSchema,
        })),
      );
    });

    const framed = (result: ConnectorResult) =>
      renderConnectorResult(result).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.map((text): ToolCallAnswer => ({
          text,
          isError: result.type === "unavailable" || (result.type === "answer" && result.isError),
        })),
      );

    const unavailable = (connector: string, reason: ConnectorUnavailable) =>
      framed({ type: "unavailable", connector, reason });

    /** The connector a name is one of, and the tool it names now, when the bot is offered it. */
    const lookUp = Effect.fn("Connectors.lookUp")(function* (botId: BotId, name: string) {
      // A slug holds no `__`, so the connector's prefix is unambiguous.
      const connector = (yield* grantedTo(botId)).find((granted) =>
        name.startsWith(`${granted.slug}__`),
      );
      if (connector === undefined) return Option.none();
      const tool = offeredTool(connector, yield* seenOf(connector.id), name);
      return tool === undefined ? Option.none() : Option.some({ connector, tool });
    });

    /** A session's hooks for one call, from J3 Bots' own. */
    const sessionHooks = (
      connector: StoredConnector,
      hooks: Partial<ConnectorCallHooks> | undefined,
    ): CallHooks | undefined =>
      hooks === undefined
        ? undefined
        : {
            progress: hooks.progress ?? (() => Effect.void),
            elicit: (request) =>
              hooks.ask === undefined
                ? Effect.succeed<ElicitationAnswer>({ _tag: "decline" })
                : hooks.ask(refOf(connector), request),
          };

    /**
     * Runs `use` with a session of the connector for `botId`, and keeps what
     * the outcome says of the connector, as a tool's call does: a failure is
     * the bot's to read in J3 Bots' words (`ConnectorUnavailableError`), a
     * connector the bot lost on the way is not offered.
     */
    const withSession = Effect.fn("Connectors.withSession")(function* <A>(
      connector: StoredConnector,
      botId: BotId,
      use: (session: McpSession) => Effect.Effect<A, ConnectorFailure>,
    ) {
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openFor(connector, botId).pipe(
            Effect.mapError((failure) =>
              failure._tag === "ConnectorGone" || failure._tag === "ExceededCapacityError"
                ? failure
                : ({ activity: "connect", failure } satisfies Stumble),
            ),
          );
          return yield* use(session).pipe(
            Effect.mapError((failure): Stumble => ({ activity: "call", failure })),
          );
        }),
      ).pipe(Effect.result);
      if (Result.isSuccess(outcome)) {
        yield* record(connector.id, { _tag: "answered" });
        return outcome.success;
      }
      const stumble = outcome.failure;
      if (isGone(stumble)) return yield* new ToolNotOffered();
      // Every session this server keeps open is in use: no fault of the connector's.
      if (Cause.isExceededCapacityError(stumble)) {
        return yield* new ConnectorUnavailableError({ reason: "busy" });
      }
      // The bot lost the connector before the call went out: it went unsigned.
      if (stumble.failure._tag === "Withdrawn") {
        yield* closeSessions(connector.id, botId);
        return yield* new ToolNotOffered();
      }
      yield* record(connector.id, observe(stumble.failure, stumble.activity));
      if (isCommand(connector)) {
        if (breaksProcess(stumble.failure)) yield* processes.stop(connector.id);
      } else if (breaksSession(stumble.failure)) {
        yield* RcMap.invalidate(sessions, sessionKey(connector.id, botId));
      }
      if (stumble.failure._tag === "NeedsSignIn") {
        yield* signIns.needed({ botId, connectorId: connector.id });
      }
      return yield* new ConnectorUnavailableError({ reason: unavailableOf(stumble.failure) });
    });

    /**
     * A tool's app, read alongside its call through the same session: its
     * document, or none when the tool has none, or its server's answer is not
     * one J3 Bots shows. Nothing of it counts against the connector: the call
     * is what the bot asked for.
     */
    const appOf = (session: McpSession, connector: StoredConnector, tool: CatalogTool) => {
      const uri = toolUiOf(tool.ui).resourceUri;
      if (uri === null) return Effect.succeed(Option.none<AppDocument>());
      return session.readAppResource(uri, MAX_APP_RESOURCE_JSON_BYTES).pipe(
        Effect.map((answer) => appDocumentOf(answer, uri)),
        Effect.flatMap((read) =>
          Result.isSuccess(read)
            ? Effect.succeedSome(read.success)
            : Effect.logInfo("A connector's app was not shown").pipe(
                Effect.annotateLogs({ connectorId: connector.id, reason: read.failure }),
                Effect.as(Option.none<AppDocument>()),
              ),
        ),
        Effect.catch((failure: ConnectorFailure) =>
          Effect.logInfo("A connector's app could not be read").pipe(
            Effect.annotateLogs({ connectorId: connector.id, reason: failure._tag }),
            Effect.as(Option.none<AppDocument>()),
          ),
        ),
      );
    };

    const call = Effect.fn("Connectors.call")(function* (input: {
      readonly botId: BotId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly hooks?: ConnectorCallHooks;
    }) {
      const found = yield* lookUp(input.botId, input.name);
      if (Option.isNone(found)) return yield* new ToolNotOffered();
      const { connector } = found.value;
      const outcome = yield* withSession(connector, input.botId, (session) =>
        Effect.gen(function* () {
          // Opening the session listed the tools again: the tool must still be offered.
          const now = yield* lookUp(input.botId, input.name).pipe(
            Effect.flatMap(Option.match({ onNone: () => new Withdrawn(), onSome: Effect.succeed })),
          );
          if (input.hooks !== undefined) {
            yield* input.hooks.started({ connector: refOf(connector), ui: now.tool.ui });
          }
          const hooks = sessionHooks(connector, input.hooks);
          return yield* Effect.all(
            [
              session.callTool({
                name: now.tool.name,
                arguments: input.arguments,
                ...(hooks === undefined ? {} : { hooks }),
              }),
              appOf(session, connector, now.tool),
            ],
            { concurrency: 2 },
          ).pipe(Effect.map(([answer, document]) => ({ tool: now.tool, answer, document })));
        }),
      ).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        if (outcome.failure._tag === "ToolNotOffered") return yield* outcome.failure;
        const line = yield* unavailable(connector.name, outcome.failure.reason);
        return { ...line, app: Option.none() } satisfies CalledTool;
      }
      const { tool, answer, document } = outcome.success;
      const framedAnswer = yield* framed({
        type: "answer",
        connector: connector.name,
        tool: tool.name,
        text: answer.text,
        isError: answer.isError,
        cut: answer.cut,
      });
      return {
        ...framedAnswer,
        app: Option.map(document, (opened): OpenedApp => ({
          connectorId: connector.id,
          connector: connector.name,
          tool: {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          document: opened,
          result: answer.result,
        })),
      } satisfies CalledTool;
    });

    /** The connectors `botId` may use that are connected, or the one `slug` names. */
    const usable = Effect.fn("Connectors.usable")(function* (botId: BotId, slug?: string) {
      const granted = (yield* grantedTo(botId)).filter(
        (connector) => slug === undefined || connector.slug === slug,
      );
      if (slug !== undefined && granted.length === 0) return yield* new ToolNotOffered();
      const seen = yield* Ref.get(seenRef);
      const unavailable = yield* Ref.get(secretsUnavailable);
      const states = yield* Ref.get(signInStates);
      return granted.filter(
        (connector) =>
          statusOfConnector(
            connector,
            seen.get(connector.id) ?? NOTHING_SEEN,
            unavailable,
            Option.fromNullishOr(states.get(connector.id)),
          )._tag === "connected",
      );
    });

    /**
     * Runs an app's request through `botId`'s session with the connector:
     * only while the bot is granted it and it is connected, as for the bot's
     * own calls, both checked again once the session is open, which may have
     * waited on a command connector's process starting; and only while
     * `permitted` holds then. `use` answers a refusal when the request is not
     * one an app may make.
     */
    const appRequest = Effect.fn("Connectors.appRequest")(
      function* (
        botId: BotId,
        connectorId: ConnectorId,
        permitted: Effect.Effect<boolean>,
        use: (
          session: McpSession,
          connector: StoredConnector,
        ) => Effect.Effect<ConnectorAppAnswer, ConnectorFailure>,
      ) {
        const connector = (yield* usable(botId)).find((granted) => granted.id === connectorId);
        if (connector === undefined) {
          const granted = (yield* grantedTo(botId)).some((granted) => granted.id === connectorId);
          return { _tag: "refused", reason: granted ? "unavailable" : "gone" } as const;
        }
        return yield* withSession(connector, botId, (session) =>
          Effect.gen(function* () {
            const now = (yield* grantedTo(botId)).find((granted) => granted.id === connectorId);
            if (now === undefined) return yield* new Withdrawn();
            if (!(yield* permitted)) return { _tag: "refused", reason: "needs-allow" } as const;
            return yield* use(session, now);
          }),
        );
      },
      Effect.catchTags({
        ToolNotOffered: () =>
          Effect.succeed<ConnectorAppAnswer>({ _tag: "refused", reason: "gone" }),
        ConnectorUnavailableError: () =>
          Effect.succeed<ConnectorAppAnswer>({ _tag: "refused", reason: "unavailable" }),
      }),
    );

    /** An answer an app is given, or `too-large` when its server's was. */
    const appAnswer = (result: Schema.Json | null): ConnectorAppAnswer =>
      result === null ? { _tag: "refused", reason: "too-large" } : { _tag: "answer", result };

    const appCall = Effect.fn("Connectors.appCall")(function* (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly permitted: Effect.Effect<boolean>;
    }) {
      return yield* appRequest(
        input.botId,
        input.connectorId,
        input.permitted,
        (session, connector) =>
          Effect.gen(function* () {
            // Opening the session listed the tools again: checked against that listing.
            const seen = yield* seenOf(connector.id);
            const tool = offeredOf(connector, seen).find(
              (offered) => offered.name === input.name && toolUiOf(offered.ui).app,
            );
            if (tool === undefined) return { _tag: "refused", reason: "not-for-apps" } as const;
            const answer = yield* session.callTool({ name: tool.name, arguments: input.arguments });
            return appAnswer(answer.result);
          }),
      );
    });

    const appRead = Effect.fn("Connectors.appRead")(function* (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly uri: string;
    }) {
      return yield* appRequest(input.botId, input.connectorId, Effect.succeed(true), (session) =>
        session
          .readAppResource(input.uri, MAX_CONNECTOR_APP_DATA_BYTES)
          .pipe(Effect.map(appAnswer)),
      );
    });

    /** What each usable connector lists of a kind it offers; one that fails to list is left out. */
    const listingsOf = <A>(
      botId: BotId,
      slug: string | undefined,
      offered: (session: McpSession) => boolean,
      list: (session: McpSession) => Effect.Effect<ReadonlyArray<A>, ConnectorFailure>,
    ) =>
      Effect.flatMap(usable(botId, slug), (connectors) =>
        Effect.forEach(
          connectors,
          (connector) =>
            withSession(connector, botId, (session) =>
              offered(session) ? list(session) : Effect.succeed<ReadonlyArray<A>>([]),
            ).pipe(
              Effect.map((items): ReadonlyArray<Listed<A>> =>
                items.length === 0 ? [] : [{ connector: refOf(connector), items }],
              ),
              Effect.orElseSucceed((): ReadonlyArray<Listed<A>> => []),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((all) => all.flat())),
      );

    const listedPrompts = (botId: BotId, slug?: string) =>
      listingsOf(
        botId,
        slug,
        (session) => session.info.offers.prompts,
        (session) => session.listPrompts,
      );

    /** Each connector's items that hold every word of `search`, in any case; connectors left with none are left out. */
    const matching = <A>(
      listings: ReadonlyArray<Listed<A>>,
      search: string | undefined,
      fields: (item: A) => ReadonlyArray<string | null>,
    ): ReadonlyArray<Listed<A>> => {
      const words = (search ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word !== "");
      return listings.flatMap(({ connector, items }) => {
        const kept = items.filter((item) => {
          const haystack = fields(item).join(" ").toLowerCase();
          return words.every((word) => haystack.includes(word));
        });
        return kept.length === 0 ? [] : [{ connector, items: kept }];
      });
    };

    /** Each connector's listing framed for the bot, one block each, or J3 Bots' line when there is none. */
    const framedListings = (
      of: "resources" | "prompts",
      listings: ReadonlyArray<{
        readonly connector: ConnectorRef;
        readonly listing: Parameters<typeof listingText>[0];
      }>,
    ) =>
      listings.length === 0
        ? Effect.succeed<ToolCallAnswer>({ text: NOTHING_LISTED[of], isError: false })
        : Effect.forEach(listings, ({ connector, listing }) =>
            renderConnectorResult({
              type: "data",
              connector: connector.name,
              slug: connector.slug,
              about: { kind: "listing", of },
              ...listingText(listing),
            }),
          ).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.map((blocks): ToolCallAnswer => ({ text: blocks.join("\n\n"), isError: false })),
          );

    const resources = (input: {
      readonly botId: BotId;
      readonly slug?: string;
      readonly search?: string;
    }) =>
      listingsOf(
        input.botId,
        input.slug,
        (session) => session.info.offers.resources,
        (session) => session.listResources,
      ).pipe(
        Effect.flatMap((listings) =>
          framedListings(
            "resources",
            matching(listings, input.search, (resource: ListedResource) => [
              resource.uri,
              resource.name,
              resource.title,
              resource.description,
            ]).map(({ connector, items }) => ({
              connector,
              listing: { of: "resources", items },
            })),
          ),
        ),
      );

    const prompts = (input: {
      readonly botId: BotId;
      readonly slug?: string;
      readonly search?: string;
    }) =>
      listedPrompts(input.botId, input.slug).pipe(
        Effect.flatMap((listings) =>
          framedListings(
            "prompts",
            matching(listings, input.search, (prompt: ListedPrompt) => [
              prompt.name,
              prompt.title,
              prompt.description,
            ]).map(({ connector, items }) => ({ connector, listing: { of: "prompts", items } })),
          ),
        ),
      );

    /** Why J3 Bots can't reach `connector` now, from what it last saw of it; none once it is connected. */
    const unusable = Effect.fn("Connectors.unusable")(function* (connector: StoredConnector) {
      const status = statusOfConnector(
        connector,
        yield* seenOf(connector.id),
        yield* Ref.get(secretsUnavailable),
        Option.fromNullishOr((yield* Ref.get(signInStates)).get(connector.id)),
      );
      switch (status._tag) {
        case "connected":
          return Option.none<ConnectorUnavailable>();
        case "needs-sign-in":
        case "secrets-unavailable":
          return Option.some<ConnectorUnavailable>(status._tag);
        case "failing":
          return Option.some<ConnectorUnavailable>("unreachable");
      }
    });

    /**
     * What `use` gets from the connector `slug` names for `botId`, framed by
     * `frame` as untrusted data, or J3 Bots' own line when it gets nothing.
     */
    const readFor = Effect.fn("Connectors.readFor")(function* <A>(
      botId: BotId,
      slug: string,
      use: (
        connector: StoredConnector,
      ) => Effect.Effect<A, ConnectorUnavailableError | ToolNotOffered>,
      frame: (connector: StoredConnector, value: A) => ConnectorResult,
    ) {
      const connector = (yield* grantedTo(botId)).find((granted) => granted.slug === slug);
      if (connector === undefined) return yield* new ToolNotOffered();
      const blocked = yield* unusable(connector);
      if (Option.isSome(blocked)) return yield* unavailable(connector.name, blocked.value);
      const outcome = yield* use(connector).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        if (outcome.failure._tag === "ToolNotOffered") return yield* outcome.failure;
        return yield* unavailable(connector.name, outcome.failure.reason);
      }
      return yield* framed(frame(connector, outcome.success));
    });

    const fetchResource = (
      connector: StoredConnector,
      botId: BotId,
      uri: string,
      hooks: Pick<ConnectorCallHooks, "ask"> | undefined,
    ) => {
      const session = sessionHooks(connector, hooks);
      return withSession(connector, botId, (opened) =>
        opened.readResource({ uri, ...(session === undefined ? {} : { hooks: session }) }),
      );
    };

    const fetchPrompt = (
      connector: StoredConnector,
      botId: BotId,
      prompt: { readonly name: string; readonly arguments: Readonly<Record<string, string>> },
      hooks: Pick<ConnectorCallHooks, "ask"> | undefined,
    ) => {
      const session = sessionHooks(connector, hooks);
      return withSession(connector, botId, (opened) =>
        opened.getPrompt({ ...prompt, ...(session === undefined ? {} : { hooks: session }) }),
      );
    };

    const readResource = (input: {
      readonly botId: BotId;
      readonly slug: string;
      readonly uri: string;
      readonly hooks?: Pick<ConnectorCallHooks, "ask">;
    }) =>
      readFor(
        input.botId,
        input.slug,
        (connector) => fetchResource(connector, input.botId, input.uri, input.hooks),
        (connector, read: ResourceRead): ConnectorResult => ({
          type: "data",
          connector: connector.name,
          slug: connector.slug,
          about: { kind: "resource", uri: input.uri },
          text:
            read.contents.length === 1
              ? read.contents.map(resourceText).join("")
              : read.contents
                  .map((contents) => `[${contents.uri}]\n${resourceText(contents)}`)
                  .join("\n\n"),
          cut: read.cut,
        }),
      );

    const getPrompt = (input: {
      readonly botId: BotId;
      readonly slug: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, string>>;
      readonly hooks?: Pick<ConnectorCallHooks, "ask">;
    }) =>
      readFor(
        input.botId,
        input.slug,
        (connector) =>
          fetchPrompt(
            connector,
            input.botId,
            { name: input.name, arguments: input.arguments },
            input.hooks,
          ),
        (connector, prompt: PromptText): ConnectorResult => ({
          type: "data",
          connector: connector.name,
          slug: connector.slug,
          about: { kind: "prompt", name: input.name },
          text: [
            ...(prompt.description === null ? [] : [prompt.description]),
            ...prompt.messages.map((message) => `[${message.role}]\n${message.text}`),
          ].join("\n\n"),
          cut: prompt.cut,
        }),
      );

    const menuPrompts = Effect.fn("Connectors.menuPrompts")(function* (botId: BotId) {
      if (Option.isNone(yield* bots.find(botId))) return yield* new NotFound({ resource: "bot" });
      const listed = yield* listedPrompts(botId).pipe(
        Effect.orElseSucceed((): ReadonlyArray<Listed<Prompt>> => []),
      );
      return listed.flatMap(({ connector, items }) =>
        items.map((prompt): ConnectorPrompt => ({
          connectorId: connector.id,
          name: prompt.name,
          title: prompt.title,
          description: prompt.description,
          arguments: prompt.arguments.map((argument) => ({
            name: argument.name,
            title: argument.title,
            description: argument.description,
            required: argument.required,
          })),
        })),
      );
    });

    const renderPrompt = Effect.fn("Connectors.renderPrompt")(function* (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
      readonly name: string;
      readonly arguments: PromptArguments;
    }) {
      const connector = (yield* grantedTo(input.botId)).find((c) => c.id === input.connectorId);
      if (connector === undefined) return yield* new NotFound({ resource: "connector" });
      const listed = yield* listedPrompts(input.botId, connector.slug).pipe(
        Effect.orElseSucceed((): ReadonlyArray<Listed<Prompt>> => []),
      );
      const prompt = listed
        .flatMap((listing) => listing.items)
        .find((item) => item.name === input.name);
      if (prompt === undefined) return yield* new Conflict({ reason: "connector-unavailable" });
      const names = new Set(prompt.arguments.map((argument) => argument.name));
      const given = Object.entries(input.arguments).filter(([, value]) => value !== "");
      if (
        given.some(([name]) => !names.has(name)) ||
        prompt.arguments.some(
          (argument) => argument.required && !given.some(([name]) => name === argument.name),
        )
      ) {
        return yield* new Invalid({ reason: "prompt-arguments" });
      }
      const rendered = yield* fetchPrompt(
        connector,
        input.botId,
        { name: input.name, arguments: Object.fromEntries(given) },
        undefined,
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "ToolNotOffered"
            ? new NotFound({ resource: "connector" })
            : new Conflict({ reason: "connector-unavailable" }),
        ),
      );
      return {
        text: rendered.messages.map((message) => message.text).join("\n\n"),
        cut: rendered.cut,
      };
    });

    const subscribe = Stream.unwrap(
      Effect.gen(function* () {
        // Joined before the snapshot is read, so no change falls between.
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot: ConnectorsEvent = {
          _tag: "snapshot",
          connectors: yield* Effect.forEach(yield* store.all, render),
        };
        return Stream.concat(
          Stream.succeed(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(
              Effect.fn("Connectors.changed")(function* (change: Change) {
                const connector =
                  change._tag === "remove" ? Option.none() : yield* store.get(change.id);
                const event: ConnectorsEvent = Option.isNone(connector)
                  ? { _tag: "changed", upsert: [], remove: [change.id] }
                  : { _tag: "changed", upsert: [yield* render(connector.value)], remove: [] };
                return event;
              }),
            ),
          ),
        );
      }),
    );

    /** Who a connector goes to when nobody named bots: every bot (decision 0049). */
    const EVERY_BOT: ConnectorGrant = { _tag: "all-bots" };

    /**
     * Lists the tools at a new connector's address, signed with the headers
     * the operator gave: whether it answers, and whether it needs a sign-in.
     */
    const probe = (
      url: URL,
      policy: UrlPolicy,
      headers: ReadonlyArray<SecretHeader>,
      formSecrets: ReadonlyArray<NamedSecret>,
    ) =>
      Effect.scoped(
        Effect.flatMap(
          openSession({
            url,
            policy,
            credentials: {
              current: Effect.succeed({
                bearer: Option.none(),
                headers,
                hidden: hiddenOf(formSecrets),
              }),
              rejected: () => Effect.fail(new NeedsSignIn()),
            },
            limits: reach.limits,
            client: CLIENT,
            cache: responseCache(),
            onListChanged: () => Effect.void,
          }),
          (session) => session.listTools,
        ),
      ).pipe(Effect.result);

    /** A listing's values, by their keys. */
    const valuesOf = (values: ReadonlyArray<ConnectorFieldValue>) =>
      new Map<string, Redacted.Redacted<string>>(values.map((value) => [value.key, value.value]));

    /** What adding a connector by its address needs: the address and headers as the operator typed them. */
    const fromAddress = (
      source: Extract<ConnectorSource, { readonly _tag: "remote" }>,
    ): Prepared => {
      const headers = source.headers.map((header): SecretHeader => ({
        name: header.name,
        value: header.value,
      }));
      return {
        name: source.name,
        glyph: null,
        publisher: { _tag: "operator" },
        listing: null,
        url: source.url,
        transport: displayTransport(source),
        headers,
        fields: headers.map(fieldOf),
        formSecrets: [],
        oauthClient: source.oauthClient,
        privateNetwork: source.privateNetwork,
        // A service that refuses a connector with no headers signs in; one with
        // headers takes them, and asks for them again when it refuses them.
        signIn: (probe) =>
          source.oauthClient !== null ||
          (Result.isFailure(probe) && probe.failure._tag === "NeedsSignIn" && headers.length === 0)
            ? "oauth"
            : headers.length > 0
              ? "fields"
              : "none",
      };
    };

    /**
     * What adding a gallery entry needs: its form, filled with the values the
     * operator gave, which gives the address and the headers to send. How it
     * signs in is the entry's, and a client cannot change it: a key in a
     * header asks for its fields again, an own app needs the operator's
     * client, and a one-tap sign-in signs in unless the server answered
     * without one. Only an own app takes a client.
     */
    const fromListing = Effect.fn("Connectors.fromListing")(function* (
      source: Extract<ConnectorSource, { readonly _tag: "listing" }>,
    ) {
      const { listing, form, fields } = yield* sources.connection(source.ref, source.language);
      if ((listing.connect === "own-app") !== (source.oauthClient !== null)) {
        return yield* new Invalid({ reason: "connector-fields" });
      }
      if (
        listing.connect !== "sign-in" &&
        listing.connect !== "own-app" &&
        listing.connect !== "token"
      ) {
        return yield* new Invalid({ reason: "connector-unsupported" });
      }
      const resolved = resolve(form, valuesOf(source.values));
      if (Result.isFailure(resolved)) return yield* new Invalid({ reason: "connector-fields" });
      const { url, displayUrl, headers } = resolved.success;
      // Clients see the address's origin only, and only when no secret of the form is in it.
      const origin = new URL(Redacted.value(url)).origin;
      if (!URL.canParse(displayUrl) || new URL(displayUrl).origin !== origin) {
        return yield* new Invalid({ reason: "connector-unsupported" });
      }
      const kind = listing.connect;
      // A sign-in sends the server's address, or the resource above it, to
      // the authorization server and through the browser: never one with a
      // key the form put in it.
      if (kind !== "token" && displayUrl !== Redacted.value(url)) {
        return yield* new Invalid({ reason: "connector-unsupported" });
      }
      const refillable = headerFieldKeys(form);
      const secretKeys = new Set(fields.filter((field) => field.secret).map((field) => field.key));
      return {
        name: listing.name,
        glyph: listing.glyph,
        publisher: listing.publisher,
        listing: source.ref,
        url,
        transport: remoteTransport(new URL(origin)),
        headers,
        fields: kind === "token" ? fields.filter((field) => refillable.has(field.key)) : [],
        formSecrets: source.values.flatMap((value) =>
          secretKeys.has(value.key) && Redacted.value(value.value) !== ""
            ? [{ name: value.key, value: value.value }]
            : [],
        ),
        oauthClient: source.oauthClient,
        privateNetwork: false,
        signIn: (probe) =>
          kind === "own-app"
            ? "oauth"
            : kind === "token"
              ? "fields"
              : Result.isSuccess(probe)
                ? "none"
                : "oauth",
      } satisfies Prepared;
    });

    const addOnce = Effect.fn("Connectors.add")(function* (input: {
      readonly id: ConnectorId;
      readonly source: ConnectorSource;
      readonly grant?: ConnectorGrant;
      readonly by: ChangeAuthor;
    }) {
      const existing = yield* store.get(input.id);
      if (Option.isSome(existing)) return yield* render(existing.value);
      const { source } = input;
      if (source._tag === "command") return yield* addCommand({ ...input, source });
      const prepared = source._tag === "remote" ? fromAddress(source) : yield* fromListing(source);
      const { headers } = prepared;
      const policy = policyOf(prepared.privateNetwork);
      const checked = checkUrl(Redacted.value(prepared.url), policy);
      const listing: Result.Result<ReadonlyArray<CatalogTool>, ConnectorFailure> = Result.isFailure(
        checked,
      )
        ? Result.fail(checked.failure)
        : prepared.oauthClient === null
          ? yield* probe(checked.success, policy, headers, prepared.formSecrets)
          : Result.fail(new NeedsSignIn());
      if (
        Result.isFailure(listing) &&
        listing.failure._tag === "UrlRefused" &&
        listing.failure.reason === "private-network"
      ) {
        return yield* new Conflict({ reason: "private-network" });
      }
      const refused = Result.isFailure(listing) && listing.failure._tag === "NeedsSignIn";
      const signIn = prepared.signIn(listing);
      // A retry of the same add seals the same values under the same id.
      yield* secrets.connectorSecrets.put({
        connectorId: connectorSecretIdOf(input.id),
        address: prepared.url,
        oauth: null,
        headers: headers.map((header) => ({ name: header.name, value: header.value })),
        command: null,
        env: [],
        formSecrets: prepared.formSecrets,
      });
      const now = yield* DateTime.now;
      const catalog = Result.isSuccess(listing) ? Option.some(listing.success) : Option.none();
      const grant = input.grant ?? EVERY_BOT;
      const inserted = yield* store
        .insert({
          id: input.id,
          name: prepared.name,
          glyph: prepared.glyph,
          publisher: prepared.publisher,
          listing: prepared.listing,
          transport: prepared.transport,
          signIn,
          fields: signIn === "fields" ? prepared.fields : [],
          privateNetwork: prepared.privateNetwork,
          grant,
          signedInAt: signIn === "fields" ? now : null,
          tools: Option.getOrNull(catalog),
          createdAt: now,
          lastChange: { by: input.by, at: now },
        })
        .pipe(
          // A connector not stored leaves no sealed record behind.
          Effect.onError(() =>
            secrets.connectorSecrets.remove(connectorSecretIdOf(input.id)).pipe(Effect.ignore),
          ),
        );
      // The same add, made at once from elsewhere: that one is the connector.
      if (Option.isNone(inserted)) return yield* render(yield* require(input.id));
      const connector = inserted.value;
      yield* updateSeen(input.id, () => ({
        listed: catalog,
        served: Option.none(),
        failing: Result.isFailure(listing)
          ? nextFailing(Option.none(), observe(listing.failure, "connect"), now)
          : Option.none(),
        refused: refused && signIn === "fields",
      }));
      if (prepared.oauthClient !== null) {
        yield* signIns
          .useOperatorClient(input.id, prepared.oauthClient)
          .pipe(
            Effect.tapError(() => store.remove(input.id).pipe(Effect.andThen(forget(input.id)))),
          );
      }
      yield* grantsChanged(yield* botsOf(connector));
      yield* toolsTouched(yield* botsOf(connector));
      yield* touch(input.id);
      return yield* render(connector);
    });

    /**
     * Adds a connector: one add or change of an id at a time, so two adds
     * with one id leave the row and the connector secret of the same one.
     */
    const add = (input: Parameters<typeof addOnce>[0]) =>
      perConnector.run(input.id)(addOnce(input));

    /**
     * Adds a connector started by command, the command line as the operator
     * confirmed it. Its process starts, in the background, to list its tools.
     */
    const addCommand = Effect.fn("Connectors.addCommand")(function* (input: {
      readonly id: ConnectorId;
      readonly source: Extract<ConnectorSource, { readonly _tag: "command" }>;
      readonly grant?: ConnectorGrant;
      readonly by: ChangeAuthor;
    }) {
      const { source } = input;
      yield* checkCommand(source);
      // A retry of the same add seals the same values under the same id.
      yield* secrets.connectorSecrets.put({
        connectorId: connectorSecretIdOf(input.id),
        address: null,
        oauth: null,
        headers: [],
        command: { program: source.command, args: source.args },
        env: source.env.map((variable) => ({ name: variable.name, value: variable.value })),
        formSecrets: [],
      });
      const now = yield* DateTime.now;
      const fields = envFieldsOf(source);
      const inserted = yield* store
        .insert({
          id: input.id,
          name: source.name,
          glyph: null,
          publisher: { _tag: "operator" },
          listing: null,
          transport: displayTransport(source),
          signIn: fields.length > 0 ? "fields" : "none",
          fields,
          privateNetwork: false,
          grant: input.grant ?? EVERY_BOT,
          signedInAt: fields.length > 0 ? now : null,
          tools: null,
          createdAt: now,
          lastChange: { by: input.by, at: now },
        })
        .pipe(
          Effect.onError(() =>
            secrets.connectorSecrets.remove(connectorSecretIdOf(input.id)).pipe(Effect.ignore),
          ),
        );
      if (Option.isNone(inserted)) return yield* render(yield* require(input.id));
      yield* grantsChanged(yield* botsOf(inserted.value));
      yield* touch(input.id);
      yield* ensureListed(input.id);
      return yield* render(inserted.value);
    });

    /**
     * What follows a connector's row out of the server: its sessions, what was
     * seen of it, then its sign-in and secrets, now or once the secrets can be read.
     */
    const forget = Effect.fn("Connectors.forget")(function* (id: ConnectorId) {
      yield* closeSessions(id);
      yield* Ref.update(seenRef, (seen) => {
        const next = new Map(seen);
        next.delete(id);
        return next;
      });
      yield* finishRemovals();
    });

    const update = Effect.fn("Connectors.update")(function* (input: {
      readonly connectorId: ConnectorId;
      readonly name?: string;
      readonly values?: ReadonlyArray<ConnectorFieldValue>;
      readonly command?: CommandLine;
      readonly by: ChangeAuthor;
    }) {
      const now = yield* DateTime.now;
      yield* perConnector.run(input.connectorId)(
        Effect.gen(function* () {
          if (input.command !== undefined) {
            yield* replaceCommand(yield* require(input.connectorId), input.command, now);
          }
          const connector = yield* require(input.connectorId);
          if (input.values !== undefined) yield* replaceValues(connector, input.values, now);
          yield* store.update(
            connector.id,
            {
              ...(input.name === undefined ? {} : { name: input.name }),
              lastChange: { by: input.by, at: now },
            },
            now,
          );
        }),
      );
      yield* touch(input.connectorId);
      return yield* render(yield* require(input.connectorId));
    });

    /**
     * A remote connector's secret with `values` given again: the
     * headers they render and the form's secrets they replace.
     */
    const withRemoteValues = Effect.fn("Connectors.withRemoteValues")(function* (
      connector: StoredConnector,
      secret: ConnectorSecret,
      values: ReadonlyArray<ConnectorFieldValue>,
    ) {
      const given = valuesOf(values);
      // Each header given again, by its name in lower case, as `headers` names it.
      const replaced = new Map<string, NamedSecret>();
      if (connector.listing === null) {
        // A field of a connector added by address is a whole header, by its name.
        for (const [name, value] of given) replaced.set(name.toLowerCase(), { name, value });
      } else {
        // A gallery entry's field can be part of a header, as the token in
        // `Bearer {token}`: its form renders the header again. The form is the
        // same in every language.
        const { form } = yield* sources.connection(connector.listing, "en");
        const headers = refill(form, given);
        if (Result.isFailure(headers)) return yield* new Invalid({ reason: "connector-fields" });
        for (const header of headers.success) replaced.set(header.name.toLowerCase(), header);
      }
      const kept = secret.headers.filter((header) => !replaced.has(header.name.toLowerCase()));
      // A gallery entry's secret field given again replaces its value; one
      // first given now, as an optional key left blank at first, joins them.
      // A connector added by address has its headers' values only.
      const secretKeys = new Set(
        connector.fields.filter((field) => field.secret).map((field) => field.key),
      );
      const formSecrets =
        connector.listing === null
          ? []
          : values.filter(
              (value) => secretKeys.has(value.key) && Redacted.value(value.value) !== "",
            );
      return {
        ...secret,
        // Every header rendered now, one the first form left out included.
        headers: [...kept, ...replaced.values()],
        formSecrets: [
          ...secret.formSecrets.filter(
            (named) => !formSecrets.some((value) => value.key === named.name),
          ),
          ...formSecrets.map((value) => ({ name: value.key, value: value.value })),
        ],
      } satisfies ConnectorSecret;
    });

    /** Replaces the values the connector's form took: those `values` names, the rest as they were. */
    const replaceValues = Effect.fn("Connectors.replaceValues")(function* (
      connector: StoredConnector,
      values: ReadonlyArray<ConnectorFieldValue>,
      now: DateTime.Utc,
    ) {
      const fields = new Map(connector.fields.map((field) => [field.key, field]));
      const fits = values.every((value) => {
        const field = fields.get(value.key);
        return field !== undefined && (!field.required || Redacted.value(value.value) !== "");
      });
      if (connector.signIn !== "fields" || !fits) {
        return yield* new Invalid({ reason: "connector-fields" });
      }
      const secret = yield* secrets.connectorSecrets.get(connectorSecretIdOf(connector.id));
      if (Option.isNone(secret)) return yield* new NotFound({ resource: "connector" });
      // A remote connector's fields are its headers, a command's its environment.
      const given = valuesOf(values);
      const next = isCommand(connector)
        ? {
            ...secret.value,
            env: secret.value.env.map((variable) => ({
              name: variable.name,
              value: given.get(variable.name) ?? variable.value,
            })),
          }
        : yield* withRemoteValues(connector, secret.value, values);
      // From the write on, nothing interrupts it: the process the old values started stops with it.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* secrets.connectorSecrets.put(next);
          yield* store.update(connector.id, { signedInAt: now }, now);
          yield* updateSeen(connector.id, (seen) => ({ ...seen, refused: false }));
          // Sessions signed with the old values close; the next call opens one with the new.
          yield* closeSessions(connector.id);
        }),
      );
      // A command's process started with the old ones: the new one starts now, which lists its
      // tools and clears a failure the old values caused.
      if (isCommand(connector)) yield* inFlight(connector.id, relist(connector.id));
    });

    /**
     * Replaces a command connector's command line with one the operator
     * confirmed. Its process stops, what was seen of it is forgotten, and the
     * new one starts to list its tools, which bots get as for any connector.
     */
    const replaceCommand = Effect.fn("Connectors.replaceCommand")(function* (
      connector: StoredConnector,
      command: CommandLine,
      now: DateTime.Utc,
    ) {
      if (!isCommand(connector)) return yield* new Invalid({ reason: "connector-unsupported" });
      yield* checkCommand(command);
      const secret = yield* secrets.connectorSecrets.get(connectorSecretIdOf(connector.id));
      if (Option.isNone(secret)) return yield* new NotFound({ resource: "connector" });
      const fields = envFieldsOf(command);
      // The whole command line is replaced in one write, so no start mixes the old one with the
      // new; from the write on, nothing interrupts it, so the old process stops with it.
      yield* Effect.uninterruptible(
        Effect.andThen(
          secrets.connectorSecrets.put({
            ...secret.value,
            command: { program: command.command, args: command.args },
            env: command.env.map((variable) => ({ name: variable.name, value: variable.value })),
          }),
          changing(
            connector.id,
            Effect.gen(function* () {
              yield* store.update(
                connector.id,
                {
                  transport: { _tag: "command", program: command.command },
                  fields,
                  signIn: fields.length > 0 ? "fields" : "none",
                  signedInAt: fields.length > 0 ? now : null,
                },
                now,
              );
              yield* closeSessions(connector.id);
              yield* updateSeen(connector.id, () => NOTHING_SEEN);
            }),
          ),
        ),
      );
      yield* inFlight(connector.id, relist(connector.id));
    });

    const remove = Effect.fn("Connectors.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
    }) {
      const connector = yield* store.get(input.connectorId);
      const losing = Option.isSome(connector) ? yield* botsOf(connector.value) : [];
      // The row goes, and what is left to do with it is recorded, in one transaction.
      yield* receipts.once({
        commandId: input.commandId,
        method: "connector.remove",
        payload: input,
        result: Schema.Void,
        apply: store.remove(input.connectorId),
      });
      // Safe to repeat: a retry after a lost reply finishes what the first left.
      yield* forget(input.connectorId);
      yield* PubSub.publish(changes, changeOf("remove", input.connectorId));
      yield* grantsChanged(losing);
      yield* toolsTouched(losing);
    });

    const setBots = Effect.fn("Connectors.setBots")(function* (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly grant: ConnectorGrant;
      readonly by: ChangeAuthor;
    }) {
      const before = yield* botsOf(yield* require(input.connectorId));
      yield* receipts.once({
        commandId: input.commandId,
        method: "connector.setBots",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const at = yield* DateTime.now;
          yield* store.update(
            input.connectorId,
            { grant: input.grant, lastChange: { by: input.by, at } },
            at,
          );
        }),
      });
      const connector = yield* require(input.connectorId);
      const after = yield* botsOf(connector);
      for (const lost of before.filter((id) => !after.includes(id))) {
        yield* closeSessions(input.connectorId, lost);
      }
      const changed = [
        ...before.filter((id) => !after.includes(id)),
        ...after.filter((id) => !before.includes(id)),
      ];
      yield* grantsChanged(changed);
      yield* toolsTouched(changed);
      yield* touch(input.connectorId);
      return yield* render(connector);
    });

    return Connectors.of({
      toolsFor,
      toolsChanged: Stream.fromPubSub(toolChanges),
      call,
      resources,
      readResource,
      prompts,
      getPrompt,
      menuPrompts,
      renderPrompt,
      appCall,
      appRead,
      subscribe,
      listed: Effect.flatMap(store.all, (all) =>
        Effect.forEach(all, (stored) =>
          Effect.map(render(stored), (connector) => ({ connector, prefix: stored.slug })),
        ),
      ).pipe(Effect.withSpan("Connectors.listed")),
      add,
      update,
      remove,
      setBots,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
