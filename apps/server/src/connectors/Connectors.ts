// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Activity,
  answerChanges,
  type CatalogTool,
  catalogOf,
  checkUrl,
  compareCatalog,
  type ConnectorFailure,
  DEFAULT_SESSION_LIMITS,
  type ListedTool,
  type McpSession,
  NeedsSignIn,
  nextFailing,
  type Observation,
  observe,
  openSession,
  type SecretHeader,
  type SessionLimits,
  type ToolAnswer,
  toolName,
  type UrlPolicy,
} from "@j3-bots/connectors";
import {
  type BotId,
  type CommandError,
  type CommandId,
  Conflict,
  Connector,
  type ConnectorField,
  type ConnectorFieldValue,
  type ConnectorGrant,
  type ConnectorId,
  type ConnectorSource,
  type ConnectorsEvent,
  type ConnectorSuggestionEntry,
  displayTransport,
  type EntryId,
  FieldKey,
  Invalid,
  NotFound,
  type ToolReviewRevision,
} from "@j3-bots/contracts";
import {
  type ConnectorResult,
  type ConnectorUnavailable,
  renderConnectorResult,
} from "@j3-bots/prompts";
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
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { Vault } from "../vault/Vault.ts";
import { ConnectorSignIns, type SignInState } from "./auth.ts";
import { ConnectorStore, type StoredConnector } from "./ConnectorStore.ts";
import { addressOf, credentialsOf, usesVault, vaultIdOf } from "./credentials.ts";
import { connectorOf, NOTHING_SEEN, offeredOf, type Seen } from "./view.ts";

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
  /** Cleaned and capped, as the operator accepted it. */
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
}

/** What a bot reads back from a connector's tool: framed as untrusted data, or J3 Bots' own line when there was no answer. */
export interface ToolCallAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** The bot is offered no tool by that name: no such connector tool, not granted, or not accepted. */
export class ToolNotOffered extends Schema.TaggedError<ToolNotOffered>()("ToolNotOffered", {}) {
  override get message(): string {
    return "No connector tool by that name is offered to this bot.";
  }
}

export class Connectors extends Context.Service<
  Connectors,
  {
    /** The tools `botId` is offered now: granted, signed-in connectors' accepted tools. */
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
    }) => Effect.Effect<ToolCallAnswer, ToolNotOffered>;
    readonly subscribe: Stream.Stream<ConnectorsEvent>;
    readonly add: (input: {
      readonly id: ConnectorId;
      readonly source: ConnectorSource;
      readonly grant?: ConnectorGrant;
      readonly suggestion: EntryId | null;
    }) => Effect.Effect<Connector, CommandError>;
    readonly update: (input: {
      readonly connectorId: ConnectorId;
      readonly name?: string;
      readonly values?: ReadonlyArray<ConnectorFieldValue>;
    }) => Effect.Effect<Connector, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
    }) => Effect.Effect<void, CommandError>;
    readonly setBots: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly grant: ConnectorGrant;
    }) => Effect.Effect<Connector, CommandError>;
    readonly acceptToolChanges: (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly revision: ToolReviewRevision;
      readonly decision: "accept" | "keep";
    }) => Effect.Effect<Connector, CommandError>;
  }
>()("@j3-bots/server/connectors/Connectors") {}

/** A connector's change, as subscribers are told it. */
interface Change {
  readonly _tag: "upsert" | "remove";
  readonly id: ConnectorId;
}
const changeOf = (tag: Change["_tag"], id: ConnectorId): Change => ({ _tag: tag, id });

/** Whose session it is: a bot's, or the one the server lists a connector's tools with. */
type Holder = BotId | "catalog";

/** A session of a connector that is no longer there. */
class ConnectorGone extends Schema.TaggedError<ConnectorGone>()("ConnectorGone", {}) {}
const isGone = Schema.is(ConnectorGone);

/** A failure, and whether it came while opening the session or during the call. */
interface Stumble {
  readonly activity: Activity;
  readonly failure: ConnectorFailure;
}

/** A session closes after this long unused. */
const IDLE_CLOSE = Duration.minutes(10);

const CLIENT = { name: "j3-bots", version: packageJson.version };

const SEPARATOR = "/";
const sessionKey = (id: ConnectorId, holder: Holder) => `${id}${SEPARATOR}${holder}`;
const decodeConnectorId = Schema.decodeUnknownOption(Connector.fields.id);

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

/** What the bot is told when a connector gave no answer. */
const unavailableOf = (failure: ConnectorFailure): ConnectorUnavailable => {
  switch (failure._tag) {
    case "NeedsSignIn":
      return "needs-sign-in";
    case "AuthFailing":
      return failure.reason === "secret-unusable" ? "needs-sign-in" : "unreachable";
    case "VaultLocked":
      return "vault-locked";
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
  }
};

/** A failure after which the session is not used again: the next call opens another. */
const breaksSession = (failure: ConnectorFailure) =>
  failure._tag === "Unreachable" || failure._tag === "NotMcp" || failure._tag === "ServerError";

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
    case "vault-locked":
      return b._tag === "vault-locked";
  }
};

export const layer = Layer.effect(
  Connectors,
  Effect.gen(function* () {
    const store = yield* ConnectorStore;
    const vault = yield* Vault;
    const signIns = yield* ConnectorSignIns;
    const bots = yield* BotStore;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const random = yield* SecureRandom.SecureRandom;
    const reach = yield* ConnectorReach;
    const policyOf = (privateNetwork: boolean): UrlPolicy => ({
      loopback: reach.loopback,
      privateNetwork: privateNetwork ? "allow" : "refuse",
      redirects: "recheck",
    });

    const seenRef = yield* Ref.make<ReadonlyMap<ConnectorId, Seen>>(new Map());
    const vaultLocked = yield* Ref.make(true);
    const signInStates = yield* Ref.make<ReadonlyMap<ConnectorId, SignInState>>(new Map());
    const changes = yield* PubSub.unbounded<Change>();
    const toolChanges = yield* PubSub.unbounded<BotId>();
    const scope = yield* Effect.scope;
    const listing = yield* Ref.make<ReadonlySet<ConnectorId>>(new Set());

    const seenOf = (id: ConnectorId) =>
      Effect.map(Ref.get(seenRef), (seen) => seen.get(id) ?? NOTHING_SEEN);
    const updateSeen = (id: ConnectorId, f: (seen: Seen) => Seen) =>
      Ref.update(seenRef, (seen) => new Map(seen).set(id, f(seen.get(id) ?? NOTHING_SEEN)));

    const render = Effect.fn("Connectors.render")(function* (connector: StoredConnector) {
      const states = yield* Ref.get(signInStates);
      return connectorOf(
        connector,
        yield* seenOf(connector.id),
        yield* Ref.get(vaultLocked),
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

    const offeredNow = Effect.fn("Connectors.offeredNow")(function* (id: ConnectorId) {
      const connector = yield* store.get(id);
      if (Option.isNone(connector)) return "";
      return fingerprint(offeredOf(connector.value, yield* seenOf(id)));
    });

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
     * What the connector's server listed: the catalog the operator accepted,
     * the first time. A listing is an answer, signed as calls are, so it
     * clears a failure and a refusal.
     */
    const recordListing = (id: ConnectorId, listed: ReadonlyArray<ListedTool>) =>
      changing(
        id,
        Effect.gen(function* () {
          const catalog = catalogOf(listed);
          yield* updateSeen(id, () => ({
            listed: Option.some(catalog),
            failing: Option.none(),
            refused: false,
          }));
          const connector = yield* store.get(id);
          if (Option.isSome(connector) && connector.value.accepted === null) {
            yield* store.update(id, { accepted: catalog }, yield* DateTime.now);
          }
        }),
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

    const sessions = yield* RcMap.make({
      lookup: Effect.fn("Connectors.openSession")(function* (key: string) {
        const [rawId, holder] = key.split(SEPARATOR);
        const id = decodeConnectorId(rawId);
        if (Option.isNone(id) || holder === undefined) return yield* new ConnectorGone();
        const connector = yield* store.get(id.value);
        if (Option.isNone(connector)) return yield* new ConnectorGone();
        const url = yield* addressOf(vault, connector.value);
        const ready = yield* Deferred.make<McpSession>();
        const session = yield* openSession({
          url,
          policy: policyOf(connector.value.privateNetwork),
          credentials: credentialsOf(vault, signIns, connector.value),
          limits: reach.limits,
          client: CLIENT,
          onToolsChanged: Deferred.await(ready).pipe(
            Effect.flatMap((opened) => opened.listTools),
            Effect.flatMap((listed) => recordListing(id.value, listed)),
            Effect.ignore,
          ),
        });
        yield* Deferred.succeed(ready, session);
        yield* recordListing(id.value, yield* session.listTools);
        return session;
      }),
      idleTimeToLive: IDLE_CLOSE,
    });

    const closeSessions = Effect.fn("Connectors.closeSessions")(function* (id: ConnectorId) {
      for (const key of yield* RcMap.keys(sessions)) {
        if (key.startsWith(`${id}${SEPARATOR}`)) yield* RcMap.invalidate(sessions, key);
      }
    });

    /** Lists the connector's tools again, through the server's own session. */
    const relist = (id: ConnectorId) =>
      Effect.scoped(RcMap.get(sessions, sessionKey(id, "catalog"))).pipe(
        Effect.tapError((failure) =>
          failure._tag === "ConnectorGone" ? Effect.void : record(id, observe(failure, "connect")),
        ),
        Effect.ignore,
      );

    /**
     * Lists the tools of a connector this server has not seen listed since it
     * started, in the background, once at a time: so its review shows, and a
     * connector that did not answer when it was added gets its tools.
     */
    const ensureListed = Effect.fn("Connectors.ensureListed")(function* (id: ConnectorId) {
      if (Option.isSome((yield* seenOf(id)).listed)) return;
      const started = yield* Ref.modify(listing, (ids): [boolean, ReadonlySet<ConnectorId>] =>
        ids.has(id) ? [false, ids] : [true, new Set(ids).add(id)],
      );
      if (!started) return;
      yield* relist(id).pipe(
        Effect.ensuring(
          Ref.update(listing, (ids) => {
            const next = new Set(ids);
            next.delete(id);
            return next;
          }),
        ),
        Effect.forkIn(scope),
      );
    });

    // The vault's state: a connector that keeps secrets there is "vault locked" while it is, and is listed once it opens.
    yield* Stream.runForEach(vault.status, (status) =>
      Effect.gen(function* () {
        const locked = status.state !== "unlocked";
        if ((yield* Ref.getAndSet(vaultLocked, locked)) === locked) return;
        for (const connector of yield* store.all) {
          if (!usesVault(connector)) continue;
          yield* touch(connector.id);
          if (!locked) yield* ensureListed(connector.id);
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

    const offeredTool = (connector: StoredConnector, seen: Seen, name: string) =>
      offeredOf(connector, seen).find((tool) => toolName(connector.slug, tool.name) === name);

    const toolsFor = Effect.fn("Connectors.toolsFor")(function* (botId: BotId) {
      const granted = yield* grantedTo(botId);
      for (const connector of granted) yield* ensureListed(connector.id);
      const seen = yield* Ref.get(seenRef);
      return granted.flatMap((connector) =>
        offeredOf(connector, seen.get(connector.id) ?? NOTHING_SEEN).map((tool): OfferedTool => ({
          name: toolName(connector.slug, tool.name),
          connectorId: connector.id,
          upstreamName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      );
    });

    const framed = (connector: StoredConnector, result: ConnectorResult) =>
      renderConnectorResult(result).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.map((text): ToolCallAnswer => ({
          text,
          isError: result.type === "unavailable" || result.isError,
        })),
      );

    const unavailable = (connector: StoredConnector, reason: ConnectorUnavailable) =>
      framed(connector, { type: "unavailable", connector: connector.name, reason });

    /** The connector a name is one of, and the tool it names now: offered, held for the operator, or neither. */
    const lookUp = Effect.fn("Connectors.lookUp")(function* (botId: BotId, name: string) {
      // A slug holds no `__`, so the connector's prefix is unambiguous.
      const connector = (yield* grantedTo(botId)).find((granted) =>
        name.startsWith(`${granted.slug}__`),
      );
      if (connector === undefined) return Option.none();
      const seen = yield* seenOf(connector.id);
      const offered = offeredTool(connector, seen, name);
      if (offered !== undefined) {
        return Option.some({ connector, tool: Option.some(offered.name) });
      }
      const held = Option.exists(seen.listed, (listed) =>
        compareCatalog(connector.accepted ?? [], listed).held.some(
          (change) => toolName(connector.slug, change.tool.name) === name,
        ),
      );
      return held ? Option.some({ connector, tool: Option.none<string>() }) : Option.none();
    });

    const call = Effect.fn("Connectors.call")(function* (input: {
      readonly botId: BotId;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) {
      const found = yield* lookUp(input.botId, input.name);
      if (Option.isNone(found)) return yield* new ToolNotOffered();
      const { connector } = found.value;
      if (Option.isNone(found.value.tool)) return yield* unavailable(connector, "held");
      const key = sessionKey(connector.id, input.botId);
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RcMap.get(sessions, key).pipe(
            Effect.mapError((failure) =>
              failure._tag === "ConnectorGone"
                ? failure
                : ({ activity: "connect", failure } satisfies Stumble),
            ),
          );
          // Opening the session listed the tools again: the tool must still be one the operator accepted.
          const now = yield* lookUp(input.botId, input.name);
          if (Option.isNone(now)) return yield* new ConnectorGone();
          return yield* Option.match(now.value.tool, {
            onNone: () => Effect.succeed(Option.none<ToolAnswer>()),
            onSome: (upstream) =>
              session.callTool({ name: upstream, arguments: input.arguments }).pipe(
                Effect.asSome,
                Effect.mapError((failure): Stumble => ({ activity: "call", failure })),
              ),
          });
        }),
      ).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        const stumble = outcome.failure;
        if (isGone(stumble)) return yield* new ToolNotOffered();
        yield* record(connector.id, observe(stumble.failure, stumble.activity));
        if (breaksSession(stumble.failure)) yield* RcMap.invalidate(sessions, key);
        if (stumble.failure._tag === "NeedsSignIn") {
          yield* signIns.needed({ botId: input.botId, connectorId: connector.id });
        }
        return yield* unavailable(connector, unavailableOf(stumble.failure));
      }
      if (Option.isNone(outcome.success)) return yield* unavailable(connector, "held");
      yield* record(connector.id, { _tag: "answered" });
      const answer = outcome.success.value;
      return yield* framed(connector, {
        type: "answer",
        connector: connector.name,
        tool: Option.getOrElse(found.value.tool, () => input.name),
        text: answer.text,
        isError: answer.isError,
        cut: answer.cut,
      });
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

    /**
     * Who a connector goes to when the operator named no bots: the bot whose
     * suggestion card they answered, else the primary bot, else none.
     */
    const defaultGrant = Effect.fn("Connectors.defaultGrant")(function* (
      suggestion: EntryId | null,
    ) {
      const card = yield* suggestionCard(suggestion);
      if (Option.isSome(card))
        return { _tag: "bots", ids: [card.value.author.botId] } satisfies ConnectorGrant;
      const primary = (yield* bots.list).find((stored) => stored.bot.primary);
      return {
        _tag: "bots",
        ids: primary === undefined ? [] : [primary.bot.id],
      } satisfies ConnectorGrant;
    });

    const suggestionCard = Effect.fn("Connectors.suggestionCard")(function* (
      suggestion: EntryId | null,
    ) {
      if (suggestion === null) return Option.none<ConnectorSuggestionEntry>();
      const found = yield* entries.find(suggestion);
      return Option.flatMap(found, ({ entry }) =>
        entry._tag === "connector-suggestion" ? Option.some(entry) : Option.none(),
      );
    });

    /** Closes the bot's suggestion card once the bot can use the connector. */
    const closeSuggestion = Effect.fn("Connectors.closeSuggestion")(function* (
      suggestion: EntryId | null,
      connector: StoredConnector,
    ) {
      const card = yield* suggestionCard(suggestion);
      if (Option.isNone(card) || card.value.status._tag !== "pending") return;
      if (!(yield* botsOf(connector)).includes(card.value.author.botId)) return;
      yield* entries.update({
        ...card.value,
        status: { _tag: "connected", connectorId: connector.id },
      });
    });

    /**
     * Lists the tools at a new connector's address, signed with the headers
     * the operator gave: whether it answers, and whether it needs a sign-in.
     */
    const probe = (url: URL, policy: UrlPolicy, headers: ReadonlyArray<SecretHeader>) =>
      Effect.scoped(
        Effect.flatMap(
          openSession({
            url,
            policy,
            credentials: {
              current: Effect.succeed({ bearer: Option.none(), headers }),
              rejected: () => Effect.fail(new NeedsSignIn()),
            },
            limits: reach.limits,
            client: CLIENT,
            onToolsChanged: Effect.void,
          }),
          (session) => session.listTools,
        ),
      ).pipe(Effect.result);

    const add = Effect.fn("Connectors.add")(function* (input: {
      readonly id: ConnectorId;
      readonly source: ConnectorSource;
      readonly grant?: ConnectorGrant;
      readonly suggestion: EntryId | null;
    }) {
      const existing = yield* store.get(input.id);
      if (Option.isSome(existing)) return yield* render(existing.value);
      const { source } = input;
      // A gallery entry is connected through its listing, and a command through a started server: neither is wired yet.
      if (source._tag !== "remote") return yield* new Invalid({ reason: "connector-unsupported" });
      const policy = policyOf(source.privateNetwork);
      const headers = source.headers.map((header): SecretHeader => ({
        name: header.name,
        value: header.value,
      }));
      const checked = checkUrl(Redacted.value(source.url), policy);
      const listing: Result.Result<ReadonlyArray<ListedTool>, ConnectorFailure> = Result.isFailure(
        checked,
      )
        ? Result.fail(checked.failure)
        : source.oauthClient === null
          ? yield* probe(checked.success, policy, headers)
          : Result.fail(new NeedsSignIn());
      if (
        Result.isFailure(listing) &&
        listing.failure._tag === "UrlRefused" &&
        listing.failure.reason === "private-network"
      ) {
        return yield* new Conflict({ reason: "private-network" });
      }
      const refused = Result.isFailure(listing) && listing.failure._tag === "NeedsSignIn";
      const signIn =
        source.oauthClient !== null || (refused && headers.length === 0)
          ? "oauth"
          : headers.length > 0
            ? "fields"
            : "none";
      yield* vault.connectorSecrets.put({
        connectorId: vaultIdOf(input.id),
        address: source.url,
        oauth: null,
        headers: headers.map((header) => ({ name: header.name, value: header.value })),
        env: [],
      });
      const now = yield* DateTime.now;
      const catalog = Result.isSuccess(listing)
        ? Option.some(catalogOf(listing.success))
        : Option.none();
      const connector: StoredConnector = {
        id: input.id,
        name: source.name,
        slug: yield* store.freeSlug(source.name),
        glyph: null,
        publisher: { _tag: "operator" },
        listing: null,
        transport: displayTransport(source),
        signIn,
        fields: signIn === "fields" ? headers.map(fieldOf) : [],
        privateNetwork: source.privateNetwork,
        grant: input.grant ?? (yield* defaultGrant(input.suggestion)),
        signedInAt: signIn === "fields" ? now : null,
        accepted: Option.getOrNull(catalog),
        keptRevision: null,
        createdAt: now,
      };
      yield* store.insert(connector);
      yield* updateSeen(input.id, () => ({
        listed: catalog,
        failing: Result.isFailure(listing)
          ? nextFailing(Option.none(), observe(listing.failure, "connect"), now)
          : Option.none(),
        refused: refused && signIn === "fields",
      }));
      if (source.oauthClient !== null) {
        yield* signIns
          .useOperatorClient(input.id, source.oauthClient)
          .pipe(Effect.tapError(() => forget(input.id)));
      }
      yield* closeSuggestion(input.suggestion, connector);
      yield* toolsTouched(yield* botsOf(connector));
      yield* touch(input.id);
      return yield* render(connector);
    });

    /** Takes a connector out of the server: its row, its sessions, what was seen of it, its secrets. */
    const forget = Effect.fn("Connectors.forget")(function* (id: ConnectorId) {
      yield* store.remove(id);
      yield* closeSessions(id);
      yield* Ref.update(seenRef, (seen) => {
        const next = new Map(seen);
        next.delete(id);
        return next;
      });
      yield* vault.connectorSecrets.remove(vaultIdOf(id)).pipe(Effect.ignore);
    });

    const update = Effect.fn("Connectors.update")(function* (input: {
      readonly connectorId: ConnectorId;
      readonly name?: string;
      readonly values?: ReadonlyArray<ConnectorFieldValue>;
    }) {
      const connector = yield* require(input.connectorId);
      const now = yield* DateTime.now;
      if (input.values !== undefined) yield* replaceValues(connector, input.values, now);
      if (input.name !== undefined) yield* store.update(connector.id, { name: input.name }, now);
      yield* touch(connector.id);
      return yield* render(yield* require(connector.id));
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
      const secret = yield* vault.connectorSecrets.get(vaultIdOf(connector.id));
      if (Option.isNone(secret)) return yield* new NotFound({ resource: "connector" });
      const given = new Map<string, Redacted.Redacted<string>>(
        values.map((value) => [value.key, value.value]),
      );
      yield* vault.connectorSecrets.put({
        ...secret.value,
        headers: secret.value.headers.map((header) => ({
          name: header.name,
          value: given.get(header.name) ?? header.value,
        })),
      });
      yield* store.update(connector.id, { signedInAt: now }, now);
      yield* updateSeen(connector.id, (seen) => ({ ...seen, refused: false }));
      // Sessions signed with the old values close; the next call opens one with the new.
      yield* closeSessions(connector.id);
    });

    const remove = Effect.fn("Connectors.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
    }) {
      const connector = yield* store.get(input.connectorId);
      if (Option.isSome(connector) && usesVault(connector.value) && (yield* Ref.get(vaultLocked))) {
        return yield* new Conflict({ reason: "vault-locked" });
      }
      const losing = Option.isSome(connector) ? yield* botsOf(connector.value) : [];
      yield* receipts.once({
        commandId: input.commandId,
        method: "connector.remove",
        payload: input,
        result: Schema.Void,
        apply: store.remove(input.connectorId),
      });
      // Safe to repeat: a retry after a lost reply finishes what the first left.
      yield* signIns.disconnect(input.connectorId);
      yield* forget(input.connectorId);
      yield* PubSub.publish(changes, changeOf("remove", input.connectorId));
      yield* toolsTouched(losing);
    });

    const setBots = Effect.fn("Connectors.setBots")(function* (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly grant: ConnectorGrant;
    }) {
      const before = yield* botsOf(yield* require(input.connectorId));
      yield* receipts.once({
        commandId: input.commandId,
        method: "connector.setBots",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* store.update(input.connectorId, { grant: input.grant }, yield* DateTime.now);
        }),
      });
      const connector = yield* require(input.connectorId);
      const after = yield* botsOf(connector);
      yield* toolsTouched([
        ...before.filter((id) => !after.includes(id)),
        ...after.filter((id) => !before.includes(id)),
      ]);
      yield* touch(input.connectorId);
      return yield* render(connector);
    });

    const acceptToolChanges = Effect.fn("Connectors.acceptToolChanges")(function* (input: {
      readonly commandId: CommandId;
      readonly connectorId: ConnectorId;
      readonly revision: ToolReviewRevision;
      readonly decision: "accept" | "keep";
    }) {
      yield* require(input.connectorId);
      yield* changing(
        input.connectorId,
        receipts.once({
          commandId: input.commandId,
          method: "connector.acceptToolChanges",
          payload: input,
          result: Schema.Void,
          apply: Effect.gen(function* () {
            const connector = yield* require(input.connectorId);
            const seen = yield* seenOf(input.connectorId);
            const answer =
              connector.accepted === null || Option.isNone(seen.listed)
                ? null
                : answerChanges(
                    connector.accepted,
                    seen.listed.value,
                    input.revision,
                    input.decision,
                  );
            if (answer === null) return yield* new Conflict({ reason: "tool-review-stale" });
            yield* store.update(
              input.connectorId,
              { accepted: answer.accepted, keptRevision: answer.kept },
              yield* DateTime.now,
            );
          }),
        }),
      );
      return yield* render(yield* require(input.connectorId));
    });

    return Connectors.of({
      toolsFor,
      toolsChanged: Stream.fromPubSub(toolChanges),
      call,
      subscribe,
      add,
      update,
      remove,
      setBots,
      acceptToolChanges,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
