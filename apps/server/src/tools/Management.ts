// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a connector's id is derived from its request's with node:crypto's SHA-256.
import * as NodeCrypto from "node:crypto";
import {
  BotId,
  type ChangeAuthor,
  CommandId,
  type Connector,
  CommandLine,
  type ConnectorCommandError,
  type ConnectorGrant,
  ConnectorFieldValues,
  ConnectorId,
  ConnectorSource,
  CuratedKey,
  GitRef,
  GitRepository,
  type LastChange,
  type ListingRef,
  RegistryName,
  RepositoryPath,
  type Skill,
  SkillName,
  type SkillScope,
} from "@j3-bots/contracts";
import { MANAGEMENT_NOTES, MANAGEMENT_REFUSED, type ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BotStore } from "../bots/BotStore.ts";
import { ConnectorSignIns } from "../connectors/auth.ts";
import { Connectors, type ListedConnector } from "../connectors/Connectors.ts";
import { ConnectorSources } from "../connectors/sources/Sources.ts";
import type { NotASkill, SkillFetchFailed } from "../skills/SkillRepositories.ts";
import { type SkillChangeError, Skills } from "../skills/Skills.ts";

/** Why a management tool did nothing, in words the bot reads. */
export class ManagementRefused extends Schema.TaggedError<ManagementRefused>()(
  "ManagementRefused",
  { reason: Schema.String },
) {}

/** The calling bot, as a management tool acts for it. */
export interface Caller {
  readonly botId: BotId;
  readonly requestId: string;
}

type Managed = Effect.Effect<Schema.Json, ManagementRefused>;

/**
 * The tools a bot manages MCP servers and skills with (decision 0049). Every
 * call is checked here against who the caller is: the primary bot manages
 * every server and skill, any other bot only its own, a server whose bots are
 * itself alone and the skills of its own workspace. The tools that change
 * anything are claimed for the caller's turn before they get here
 * (`BotTools`).
 */
export class Management extends Context.Service<
  Management,
  {
    readonly searchServers: (caller: Caller, input: ToolInput<"search_mcp_servers">) => Managed;
    readonly listServers: (caller: Caller) => Managed;
    readonly addServer: (caller: Caller, input: ToolInput<"add_mcp_server">) => Managed;
    readonly updateServer: (caller: Caller, input: ToolInput<"update_mcp_server">) => Managed;
    readonly removeServer: (caller: Caller, input: ToolInput<"remove_mcp_server">) => Managed;
    readonly setServerBots: (caller: Caller, input: ToolInput<"set_mcp_server_bots">) => Managed;
    readonly listSkills: (caller: Caller) => Managed;
    readonly saveSkill: (caller: Caller, input: ToolInput<"save_skill">) => Managed;
    readonly installSkill: (caller: Caller, input: ToolInput<"install_skill">) => Managed;
    readonly removeSkill: (caller: Caller, input: ToolInput<"remove_skill">) => Managed;
  }
>()("@j3-bots/server/tools/Management") {}

const refuse = (reason: string) => new ManagementRefused({ reason });

/** A command id for a tool call, the same on every retry of its forward. */
const commandIdOf = (requestId: string, what: string) =>
  CommandId.make(`tool:${what}:${requestId}`);

/**
 * The connector a bot's call adds: its id derived from the call's request, so
 * a forward retried under the same request finds the connector it added.
 */
const connectorIdOf = (requestId: string) =>
  ConnectorId.make(
    `conn_${NodeCrypto.createHash("sha256").update(`tool:${requestId}`).digest("hex").slice(0, 32)}`,
  );

/** A gallery entry's id as `search_mcp_servers` gives it: `curated:<key>` or `registry:<name>`. */
const listingId = (ref: ListingRef) =>
  ref._tag === "curated" ? `curated:${ref.key}` : `registry:${ref.name}`;

const decodeCuratedKey = Schema.decodeUnknownOption(CuratedKey);
const decodeRegistryName = Schema.decodeUnknownOption(RegistryName);

const listingRefOf = (id: string): Option.Option<ListingRef> => {
  const at = id.indexOf(":");
  const [kind, rest] = at < 0 ? ["", id] : [id.slice(0, at), id.slice(at + 1)];
  if (kind === "curated")
    return Option.map(decodeCuratedKey(rest), (key) => ({ _tag: "curated", key }));
  if (kind === "registry") {
    return Option.map(decodeRegistryName(rest), (name) => ({ _tag: "registry", name }));
  }
  return Option.none();
};

/** The text a decode failure gives the bot. */
const decodeOr = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown, what: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => refuse(`${what} is not valid. Nothing changed.`)),
  );

/**
 * Decodes what the bot gave for a server as the operator's form would send
 * it: a value, an argument or an address is redacted as it is decoded, and
 * a refusal names the rule it broke, never the value.
 */
const decodeSettings = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.mapError((error) => refuse(`That is not valid: ${error.message}. Nothing changed.`)),
  );

/** A record of names to values as the list of pairs the contracts take. */
const pairs = <K extends string>(
  record: Readonly<Record<string, string>> | undefined,
  key: K,
): Schema.Json => Object.entries(record ?? {}).map(([name, value]) => ({ [key]: name, value }));

const authorJson = (change: LastChange | null): Schema.Json =>
  change === null
    ? null
    : {
        by: change.by._tag === "operator" ? "your user" : { bot: change.by.botId },
        at: DateTime.formatIso(change.at),
      };

const grantJson = (grant: ConnectorGrant): Schema.Json =>
  grant._tag === "all-bots" ? "every-bot" : [...grant.ids];

const statusJson = (connector: Connector): Schema.Json => {
  const { status } = connector;
  switch (status._tag) {
    case "connected":
      return "connected";
    case "needs-sign-in":
      return { needsSignIn: status.reason };
    case "failing":
      return { failing: status.reason };
    case "secrets-unavailable":
      return "secrets-unavailable";
    case "needs-secret":
      return { needsSecret: { secret: status.secret, reason: status.reason } };
  }
};

export const layer = Layer.effect(
  Management,
  Effect.gen(function* () {
    const store = yield* BotStore;
    const connectors = yield* Connectors;
    const sources = yield* ConnectorSources;
    const signIns = yield* ConnectorSignIns;
    const skills = yield* Skills;

    const isPrimary = Effect.fnUntraced(function* (botId: BotId) {
      const self = yield* store.find(botId);
      return Option.exists(self, (found) => found.bot.primary);
    });

    /** A server is a bot's own when its bots are that bot alone. */
    const ownedBy = (connector: Connector, botId: BotId) =>
      connector.grant._tag === "bots" &&
      connector.grant.ids.length === 1 &&
      connector.grant.ids[0] === botId;

    const reaches = (connector: Connector, botId: BotId) =>
      connector.grant._tag === "all-bots" || connector.grant.ids.includes(botId);

    const serverJson = (listed: ListedConnector, mayChange: boolean): Schema.Json => ({
      id: listed.connector.id,
      name: listed.connector.name,
      prefix: listed.prefix,
      status: statusJson(listed.connector),
      bots: grantJson(listed.connector.grant),
      mayChange,
      lastChange: authorJson(listed.connector.lastChange),
    });

    /** The servers the caller sees: every one for the primary bot, those it uses otherwise. */
    const visible = Effect.fnUntraced(function* (caller: Caller) {
      const primary = yield* isPrimary(caller.botId);
      const all = yield* connectors.listed;
      return {
        primary,
        servers: primary ? all : all.filter(({ connector }) => reaches(connector, caller.botId)),
      };
    });

    /** The server `ref` names among those the caller sees, which it must be allowed to change. */
    const changeable = Effect.fnUntraced(function* (caller: Caller, ref: string) {
      const { primary, servers } = yield* visible(caller);
      const found = servers.find(({ connector, prefix }) => connector.id === ref || prefix === ref);
      if (found === undefined) return yield* refuse(MANAGEMENT_REFUSED.unknownServer(ref));
      if (!primary && !ownedBy(found.connector, caller.botId)) {
        return yield* refuse(MANAGEMENT_REFUSED.notYours(found.connector.name));
      }
      return { primary, found };
    });

    const requireBot = Effect.fnUntraced(function* (id: string) {
      const botId = yield* decodeOr(BotId, id, "That bot id");
      if (Option.isNone(yield* store.find(botId)))
        return yield* refuse(MANAGEMENT_REFUSED.unknownBot(id));
      return botId;
    });

    /** Who uses a new server: `scope` as the primary bot gives it, the caller alone otherwise. */
    const grantFor = Effect.fnUntraced(function* (
      caller: Caller,
      primary: boolean,
      scope: ToolInput<"add_mcp_server">["scope"],
    ) {
      if (scope === undefined) {
        const grant: ConnectorGrant = primary
          ? { _tag: "all-bots" }
          : { _tag: "bots", ids: [caller.botId] };
        return grant;
      }
      if (scope === "this-bot")
        return { _tag: "bots", ids: [caller.botId] } satisfies ConnectorGrant;
      if (!primary) return yield* refuse(MANAGEMENT_REFUSED.primaryOnly);
      if (scope === "every-bot") return { _tag: "all-bots" } satisfies ConnectorGrant;
      return { _tag: "bots", ids: [yield* requireBot(scope.bot)] } satisfies ConnectorGrant;
    });

    /** What a connector request's failure tells the bot. */
    const connectorRefusal = (error: ConnectorCommandError): ManagementRefused => {
      if (error._tag === "NotFound" && error.resource === "connector-listing") {
        return refuse(MANAGEMENT_REFUSED.unknownListing("that entry"));
      }
      if (error._tag === "Conflict" && error.reason === "private-network") {
        return refuse(MANAGEMENT_REFUSED.privateNetwork);
      }
      if (error._tag === "SecretRefused") {
        switch (error.problem) {
          case "missing":
            return refuse(MANAGEMENT_REFUSED.secretMissing(error.secret));
          case "no-value":
            return refuse(MANAGEMENT_REFUSED.secretNoValue(error.secret));
          case "not-shared":
            return refuse(MANAGEMENT_REFUSED.secretNotShared(error.secret));
          case "not-yours":
            return refuse(MANAGEMENT_REFUSED.secretNotYours(error.secret));
          case "in-address":
            return refuse(MANAGEMENT_REFUSED.secretInAddress);
        }
      }
      return refuse(`${error.message} Nothing changed.`);
    };

    const sourceOf = Effect.fnUntraced(function* (input: ToolInput<"add_mcp_server">) {
      if (input.gallery !== undefined) {
        const gallery = input.gallery;
        const ref = listingRefOf(gallery);
        if (Option.isNone(ref)) return yield* refuse(MANAGEMENT_REFUSED.unknownListing(gallery));
        const connection = yield* sources
          .connection(ref.value, "en")
          .pipe(Effect.mapError(() => refuse(MANAGEMENT_REFUSED.unknownListing(gallery))));
        // An app the operator registers is theirs to set up.
        if (connection.listing.connect === "own-app")
          return yield* refuse(MANAGEMENT_REFUSED.ownApp);
        return yield* decodeSettings(ConnectorSource, {
          _tag: "listing",
          ref: ref.value,
          language: "en",
          values: pairs(input.values, "key"),
          oauthClient: null,
        });
      }
      const name = input.name ?? "";
      if (input.url !== undefined) {
        return yield* decodeSettings(ConnectorSource, {
          _tag: "remote",
          name,
          url: input.url,
          headers: pairs(input.headers, "name"),
          oauthClient: null,
          // An address in the operator's own network takes their word, in Settings.
          privateNetwork: false,
        });
      }
      return yield* decodeSettings(ConnectorSource, {
        _tag: "command",
        name,
        command: input.command ?? "",
        args: input.args ?? [],
        env: pairs(input.env, "name"),
      });
    });

    /** The answer to a server added or changed: itself, and what comes next for it. */
    const addedAnswer = Effect.fnUntraced(function* (caller: Caller, connector: Connector) {
      const listed = (yield* connectors.listed).find((each) => each.connector.id === connector.id);
      const status = listed?.connector.status ?? connector.status;
      if (status._tag === "needs-sign-in") {
        // The operator signs in from a card in the caller's conversation.
        yield* signIns.needed({ botId: caller.botId, connectorId: connector.id });
      }
      const note =
        status._tag === "needs-sign-in"
          ? MANAGEMENT_NOTES.signInPending
          : status._tag === "connected"
            ? MANAGEMENT_NOTES.connected
            : MANAGEMENT_NOTES.failing;
      return {
        server:
          listed === undefined
            ? { id: connector.id, name: connector.name }
            : serverJson(listed, true),
        note,
      } satisfies Schema.Json;
    });

    const by = (caller: Caller): ChangeAuthor => ({ _tag: "bot", botId: caller.botId });

    const searchServers = Effect.fn("Management.searchServers")(function* (
      _caller: Caller,
      input: ToolInput<"search_mcp_servers">,
    ) {
      const found = yield* sources.search({ query: input.query, language: "en", all: false });
      const listings = yield* Effect.forEach(
        found.listings.slice(0, 8),
        (listing) =>
          sources.connection(listing.ref, "en").pipe(
            Effect.map(({ fields }) => fields),
            Effect.orElseSucceed(() => []),
            Effect.map((fields): Schema.Json => ({
              id: listingId(listing.ref),
              name: listing.name,
              summary: listing.summary,
              from:
                listing.publisher._tag === "domain"
                  ? listing.publisher.domain
                  : listing.publisher._tag === "community"
                    ? `community: ${listing.publisher.namespace}`
                    : "your user",
              connects: listing.connect,
              fields: fields.map((field) => ({
                key: field.key,
                label: field.label,
                secret: field.secret,
                required: field.required,
              })),
            })),
          ),
        { concurrency: "unbounded" },
      );
      return {
        servers: listings,
        registry: found.registry,
      } satisfies Schema.Json;
    });

    const listServers = Effect.fn("Management.listServers")(function* (caller: Caller) {
      const { primary, servers } = yield* visible(caller);
      return {
        servers: servers.map((listed) =>
          serverJson(listed, primary || ownedBy(listed.connector, caller.botId)),
        ),
      } satisfies Schema.Json;
    });

    const addServer = Effect.fn("Management.addServer")(function* (
      caller: Caller,
      input: ToolInput<"add_mcp_server">,
    ) {
      const primary = yield* isPrimary(caller.botId);
      const grant = yield* grantFor(caller, primary, input.scope);
      const source = yield* sourceOf(input);
      const connector = yield* connectors
        .add({ id: connectorIdOf(caller.requestId), source, grant, by: by(caller) })
        .pipe(Effect.mapError(connectorRefusal));
      return yield* addedAnswer(caller, connector);
    });

    const updateServer = Effect.fn("Management.updateServer")(function* (
      caller: Caller,
      input: ToolInput<"update_mcp_server">,
    ) {
      const { found } = yield* changeable(caller, input.server);
      const values =
        input.values === undefined
          ? undefined
          : yield* decodeSettings(ConnectorFieldValues, pairs(input.values, "key"));
      const command =
        input.command === undefined
          ? undefined
          : yield* decodeSettings(CommandLine, {
              command: input.command.command,
              args: input.command.args,
              env: pairs(input.command.env, "name"),
            });
      const connector = yield* connectors
        .update({
          connectorId: found.connector.id,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(values === undefined ? {} : { values }),
          ...(command === undefined ? {} : { command }),
          by: by(caller),
        })
        .pipe(Effect.mapError(connectorRefusal));
      return yield* addedAnswer(caller, connector);
    });

    const removeServer = Effect.fn("Management.removeServer")(function* (
      caller: Caller,
      input: ToolInput<"remove_mcp_server">,
    ) {
      const { found } = yield* changeable(caller, input.server);
      yield* connectors
        .remove({
          commandId: commandIdOf(caller.requestId, "remove"),
          connectorId: found.connector.id,
        })
        .pipe(Effect.mapError(connectorRefusal));
      return {
        removed: found.connector.name,
        note: MANAGEMENT_NOTES.removed,
      } satisfies Schema.Json;
    });

    const setServerBots = Effect.fn("Management.setServerBots")(function* (
      caller: Caller,
      input: ToolInput<"set_mcp_server_bots">,
    ) {
      if (!(yield* isPrimary(caller.botId))) return yield* refuse(MANAGEMENT_REFUSED.primaryOnly);
      const { found } = yield* changeable(caller, input.server);
      const grant: ConnectorGrant =
        input.bots === "every-bot"
          ? { _tag: "all-bots" }
          : { _tag: "bots", ids: yield* Effect.forEach(input.bots, requireBot) };
      const connector = yield* connectors
        .setBots({
          commandId: commandIdOf(caller.requestId, "bots"),
          connectorId: found.connector.id,
          grant,
          by: by(caller),
        })
        .pipe(Effect.mapError(connectorRefusal));
      return yield* addedAnswer(caller, connector);
    });

    /** Where a skill goes: `scope` as the primary bot gives it, the caller's own otherwise. */
    const skillScopeOf = Effect.fnUntraced(function* (
      caller: Caller,
      scope: ToolInput<"save_skill">["scope"],
    ) {
      if (scope === undefined || scope === "this-bot") {
        return { _tag: "bot", botId: caller.botId } satisfies SkillScope;
      }
      if (typeof scope !== "string" && scope.bot === caller.botId) {
        return { _tag: "bot", botId: caller.botId } satisfies SkillScope;
      }
      if (!(yield* isPrimary(caller.botId))) return yield* refuse(MANAGEMENT_REFUSED.primaryOnly);
      if (scope === "every-bot") return { _tag: "all-bots" } satisfies SkillScope;
      return { _tag: "bot", botId: yield* requireBot(scope.bot) } satisfies SkillScope;
    });

    /** What a skill change's failure tells the bot. */
    const skillRefusal =
      (name: string) =>
      (error: SkillChangeError | NotASkill | SkillFetchFailed): ManagementRefused => {
        switch (error._tag) {
          case "NotASkill":
            return refuse(MANAGEMENT_REFUSED.notASkill(error.reason));
          case "SkillFetchFailed":
            return refuse(MANAGEMENT_REFUSED.fetchFailed(fetchWords[error.reason]));
          case "NotFound":
            return refuse(
              error.resource === "bot"
                ? MANAGEMENT_REFUSED.unknownBot(name)
                : MANAGEMENT_REFUSED.unknownSkill(name),
            );
          case "Invalid":
            return refuse(MANAGEMENT_REFUSED.skillText);
          case "Conflict":
            switch (error.reason) {
              case "skill-shipped":
                return refuse(MANAGEMENT_REFUSED.skillShipped);
              case "skill-name-taken":
                return refuse(MANAGEMENT_REFUSED.skillNameTaken(name));
              case "skill-limit":
                return refuse(MANAGEMENT_REFUSED.skillLimit);
              case "private-location":
                return refuse(MANAGEMENT_REFUSED.privateLocation);
              default:
                return refuse(`${error.message} Nothing changed.`);
            }
        }
      };

    const skillJson = (skill: Skill, caller: Caller, primary: boolean): Schema.Json => ({
      name: skill.name,
      scope:
        skill.scope._tag === "all-bots"
          ? "every-bot"
          : skill.scope.botId === caller.botId
            ? "this-bot"
            : { bot: skill.scope.botId },
      description: skill.description,
      files: skill.files,
      source:
        skill.source === null
          ? null
          : skill.source._tag === "written"
            ? "written"
            : {
                repository: skill.source.repository,
                path: skill.source.path,
                commit: skill.source.commit,
              },
      mayChange:
        !skill.shipped &&
        (primary || (skill.scope._tag === "bot" && skill.scope.botId === caller.botId)),
      lastChange: authorJson(skill.lastChange),
    });

    const listSkills = Effect.fn("Management.listSkills")(function* (caller: Caller) {
      const primary = yield* isPrimary(caller.botId);
      const all = yield* skills.list;
      return {
        skills: all
          .filter(
            (skill) =>
              primary || skill.scope._tag === "all-bots" || skill.scope.botId === caller.botId,
          )
          .map((skill) => skillJson(skill, caller, primary)),
      } satisfies Schema.Json;
    });

    const savedAnswer = Effect.fnUntraced(function* (caller: Caller, skill: Skill) {
      const primary = yield* isPrimary(caller.botId);
      return {
        skill: skillJson(skill, caller, primary),
        note: MANAGEMENT_NOTES.skillSaved,
      } satisfies Schema.Json;
    });

    const saveSkill = Effect.fn("Management.saveSkill")(function* (
      caller: Caller,
      input: ToolInput<"save_skill">,
    ) {
      const scope = yield* skillScopeOf(caller, input.scope);
      const commandId = commandIdOf(caller.requestId, "skill");
      const skill =
        input.text !== undefined
          ? yield* skills
              .save({ commandId, scope, name: input.name, text: input.text, by: by(caller) })
              .pipe(Effect.mapError(skillRefusal(input.name)))
          : yield* skills
              .saveFolder({
                commandId,
                scope,
                name: input.name,
                owner: caller.botId,
                folder: input.folder ?? "",
                by: by(caller),
              })
              .pipe(Effect.mapError(skillRefusal(input.name)));
      return yield* savedAnswer(caller, skill);
    });

    const installSkill = Effect.fn("Management.installSkill")(function* (
      caller: Caller,
      input: ToolInput<"install_skill">,
    ) {
      const scope = yield* skillScopeOf(caller, input.scope);
      const repository = yield* decodeOr(
        GitRepository,
        input.repository,
        "The repository's address",
      );
      const at = yield* decodeOr(RepositoryPath, input.path ?? "", "The path");
      const ref = yield* decodeOr(GitRef, input.ref, "The ref");
      // The folder's own name, or the repository's for its root.
      const fallback =
        at === ""
          ? (
              new URL(repository).pathname.split("/").findLast((segment) => segment !== "") ?? ""
            ).replace(/\.git$/, "")
          : (at.split("/").at(-1) ?? "");
      const name = yield* Effect.fromOption(
        Schema.decodeOption(SkillName)(input.name ?? fallback.toLowerCase()),
      ).pipe(Effect.mapError(() => refuse(MANAGEMENT_REFUSED.noName)));
      const skill = yield* skills
        .install({
          commandId: commandIdOf(caller.requestId, "skill"),
          scope,
          name,
          repository,
          path: at,
          ref,
          by: by(caller),
        })
        .pipe(Effect.mapError(skillRefusal(name)));
      return yield* savedAnswer(caller, skill);
    });

    const removeSkill = Effect.fn("Management.removeSkill")(function* (
      caller: Caller,
      input: ToolInput<"remove_skill">,
    ) {
      const scope = yield* skillScopeOf(caller, input.scope);
      yield* skills
        .remove({ commandId: commandIdOf(caller.requestId, "skill"), scope, name: input.name })
        .pipe(Effect.mapError(skillRefusal(input.name)));
      return { removed: input.name, note: MANAGEMENT_NOTES.skillRemoved } satisfies Schema.Json;
    });

    return Management.of({
      searchServers,
      listServers,
      addServer,
      updateServer,
      removeServer,
      setServerBots,
      listSkills,
      saveSkill,
      installSkill,
      removeSkill,
    });
  }),
);

/** Why a repository could not be fetched, as the bot reads it. */
const fetchWords: Record<SkillFetchFailed["reason"], string> = {
  refused: "its address is not a public https: address J3 Bots reaches",
  "private-network": "its address is in your user's own network",
  unreachable: "it did not answer as a git repository",
  "no-ref": "it has no branch, tag or commit of that name",
  "no-git": "git 2.37 or later is not installed where J3 Bots runs; tell your user",
  "timed-out": "it took longer than two minutes",
};
