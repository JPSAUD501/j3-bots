// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppDocument } from "@j3-bots/connectors";
import {
  BotId,
  type ConnectorAppAnswer,
  type ConnectorAppContext,
  type ConnectorAppContextOutcome,
  ConnectorAppCsp,
  type ConnectorAppRef,
  ConnectorAppTool,
  type ConnectorAppView,
  ConnectorAppViewId,
  connectorAppToolLabel,
  ConnectorId,
  Label,
  MAX_CONNECTOR_APPS_PER_TURN,
  NotFound,
  RoomId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore } from "../bots/BotStore.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import type { CallPlace } from "../turns/ConnectorSteps.ts";
import { type Audience, AudienceColumn, audienceColumns, audienceOf } from "../turns/model.ts";
import { liveTarget } from "../turns/liveTarget.ts";
import type { OpenedApp } from "./Connectors.ts";
import { Connectors } from "./Connectors.ts";

/**
 * The apps connectors' tools open (`docs/architecture/server.md`, "Connector
 * apps", decisions 0048 and 0093): each one an entry of the bot's reply, where
 * the call that opened it happened, and the requests its page makes, which go
 * to the connector as the bot's, under the bot's grant.
 */
export class ConnectorApps extends Context.Service<
  ConnectorApps,
  {
    /**
     * Keeps the app a bot's call opened, as an entry of the turn's reply, in
     * the conversation or room the turn speaks to. A routine's turn shows no
     * app, nor does one whose room is gone, or one that already shows
     * `MAX_CONNECTOR_APPS_PER_TURN`.
     */
    readonly record: (input: {
      readonly place: CallPlace;
      readonly botId: BotId;
      readonly input: Schema.JsonObject;
      readonly app: OpenedApp;
    }) => Effect.Effect<boolean>;
    /** An app, ready to draw. */
    readonly open: (viewId: ConnectorAppViewId) => Effect.Effect<ConnectorAppView, NotFound>;
    /**
     * A tool call an app asked for, made as its bot's call: one the operator
     * `allowed`, or any while the bot is in full access.
     */
    readonly callTool: (input: {
      readonly viewId: ConnectorAppViewId;
      readonly name: string;
      readonly arguments: Schema.JsonObject;
      readonly allowed: boolean;
    }) => Effect.Effect<ConnectorAppAnswer, NotFound>;
    /** A resource an app asked to read, read as its bot. */
    readonly readResource: (input: {
      readonly viewId: ConnectorAppViewId;
      readonly uri: string;
    }) => Effect.Effect<ConnectorAppAnswer, NotFound>;
    /**
     * What an app sets as context for its bot: it replaces what the same app
     * set before, for the bot's next turn where the app is shown, and wakes
     * nobody. Empty, it takes back what the app set.
     */
    readonly setContext: (input: {
      readonly viewId: ConnectorAppViewId;
      readonly context: ConnectorAppContext;
    }) => Effect.Effect<ConnectorAppContextOutcome, NotFound>;
  }
>()("@j3-bots/server/connectors/ConnectorApps") {}

/** Where a call's turn speaks: its session's purpose, and the turn's audience. */
const TurnPlace = Schema.Struct({
  purpose: Schema.Literals(["main", "side"]),
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  finished_at: Schema.NullOr(Schema.String),
});

/** Where a view is shown: its entry's room, or, for a view of a bot's conversation, none. */
const ShownIn = Schema.Struct({ room_id: Schema.NullOr(RoomId) });

const StoredView = Schema.Struct({
  id: ConnectorAppViewId,
  bot_id: BotId,
  connector_id: ConnectorId,
  connector_name: Label,
  tool_json: json(ConnectorAppTool),
  input_json: json(Schema.JsonObject),
  result_json: Schema.NullOr(json(Schema.Json)),
  csp_json: json(ConnectorAppCsp),
  html: Schema.String,
});

const encodeTool = Schema.encodeEffect(json(ConnectorAppTool));
const encodeObject = Schema.encodeEffect(json(Schema.JsonObject));
const encodeData = Schema.encodeEffect(json(Schema.Json));
const encodeCsp = Schema.encodeEffect(json(ConnectorAppCsp));

const encoder = new TextEncoder();

export const layer = Layer.effect(
  ConnectorApps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const entries = yield* Entries;
    const ids = yield* Ids;
    const store = yield* BotStore;
    const connectors = yield* Connectors;
    const digest = yield* Digest.Digest;

    const turnOf = SqlSchema.findOneOption({
      Request: Schema.Struct({ sessionId: Schema.String, turnId: Schema.String }),
      Result: TurnPlace,
      execute: ({ sessionId, turnId }) => sql`
        SELECT s.purpose, t.audience, t.audience_room_id, t.finished_at
        FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE t.session_id = ${sessionId} AND t.engine_turn_id = ${turnId}
      `,
    });

    const viewOf = SqlSchema.findOneOption({
      Request: ConnectorAppViewId,
      Result: StoredView,
      execute: (viewId) => sql`
        SELECT v.id, v.bot_id, v.connector_id, v.connector_name, v.tool_json, v.input_json,
               v.result_json, v.csp_json, d.html
        FROM connector_app_views v
        JOIN connector_app_documents d ON d.digest = v.document_digest
        WHERE v.id = ${viewId}
      `,
    });

    const shownIn = SqlSchema.findOneOption({
      Request: ConnectorAppViewId,
      Result: ShownIn,
      execute: (viewId) => sql`
        SELECT e.room_id FROM connector_app_views v JOIN entries e ON e.id = v.entry_id
        WHERE v.id = ${viewId}
      `,
    });

    /**
     * Who the call's turn speaks to while it runs: the bot's conversation, or
     * a room. A routine's turn speaks to no one, and a turn that ended, as
     * when the operator stopped it before its call came back, no more.
     */
    const audienceOfCall = Effect.fn("ConnectorApps.audienceOfCall")(function* (place: CallPlace) {
      const turn = yield* turnOf({ sessionId: place.sessionId, turnId: place.turnId });
      if (Option.isNone(turn) || turn.value.purpose === "side" || turn.value.finished_at !== null) {
        return Option.none<Audience>();
      }
      return Option.some(audienceOf(turn.value));
    });

    /** Where the turn's reply goes, while its room is there and the bot is one of its members. */
    const targetOfCall = liveTarget(sql);

    /** How many apps the call's turn shows already. */
    const shownBy = (place: CallPlace) =>
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM connector_app_views
        WHERE session_id = ${place.sessionId} AND engine_turn_id = ${place.turnId}
      `.pipe(Effect.map(([row]) => row?.n ?? 0));

    const keepDocument = Effect.fn("ConnectorApps.keepDocument")(function* (document: AppDocument) {
      const key = yield* digest.digestHex(Digest.sha256, encoder.encode(document.html));
      yield* sql`
        INSERT INTO connector_app_documents (digest, html) VALUES (${key}, ${document.html})
        ON CONFLICT (digest) DO NOTHING
      `;
      return key;
    });

    const record = Effect.fn("ConnectorApps.record")(function* (input: {
      readonly place: CallPlace;
      readonly botId: BotId;
      readonly input: Schema.JsonObject;
      readonly app: OpenedApp;
    }) {
      const { app } = input;
      const viewId = ConnectorAppViewId.make(yield* ids.make("app"));
      const tool = yield* encodeTool(app.tool);
      const arguments_ = yield* encodeObject(input.input);
      const result = app.result === null ? null : yield* encodeData(app.result);
      const csp = yield* encodeCsp(app.document.csp);
      const at = timeText(yield* DateTime.now);
      const shown = yield* transaction(
        Effect.gen(function* () {
          const audience = yield* audienceOfCall(input.place);
          if (Option.isNone(audience)) return false;
          const target = yield* targetOfCall(input.botId, audience.value);
          if (target === null) return false;
          if ((yield* shownBy(input.place)) >= MAX_CONNECTOR_APPS_PER_TURN) return false;
          const digestKey = yield* keepDocument(app.document);
          const ref: ConnectorAppRef = {
            viewId,
            connectorId: app.connectorId,
            connector: app.connector,
            glyph: app.glyph,
            tool: connectorAppToolLabel(app.tool),
          };
          const entry = yield* entries.append({
            target,
            entry: { _tag: "connector-app", author: { _tag: "bot", botId: input.botId }, app: ref },
          });
          yield* sql`
            INSERT INTO connector_app_views (
              id, entry_id, bot_id, connector_id, connector_name, tool_json, input_json,
              result_json, document_digest, csp_json, created_at, session_id, engine_turn_id
            ) VALUES (
              ${viewId}, ${entry.id}, ${input.botId}, ${app.connectorId}, ${app.connector},
              ${tool}, ${arguments_}, ${result}, ${digestKey}, ${csp}, ${at},
              ${input.place.sessionId}, ${input.place.turnId}
            )
          `;
          return true;
        }),
      );
      yield* Effect.logInfo(shown ? "connector app shown" : "connector app not shown").pipe(
        Effect.annotateLogs({
          botId: input.botId,
          connectorId: app.connectorId,
          tool: app.tool.name,
          viewId,
        }),
      );
      return shown;
    }, Effect.orDie);

    const found = Effect.fn("ConnectorApps.found")(function* (viewId: ConnectorAppViewId) {
      const view = yield* viewOf(viewId).pipe(Effect.orDie);
      if (Option.isNone(view)) {
        return yield* new NotFound({ resource: "connector-app" });
      }
      return view.value;
    });

    /** Whether the bot's own calls run without asking now: only in full access. */
    const runsUnasked = (botId: BotId) =>
      store
        .find(botId)
        .pipe(
          Effect.map((bot) => Option.isSome(bot) && bot.value.bot.permissionMode === "full-access"),
        );

    const open = Effect.fn("ConnectorApps.open")(function* (viewId: ConnectorAppViewId) {
      const view = yield* found(viewId);
      return {
        viewId: view.id,
        botId: view.bot_id,
        connectorId: view.connector_id,
        connector: view.connector_name,
        tool: view.tool_json,
        html: view.html,
        csp: view.csp_json,
        input: view.input_json,
        result: view.result_json,
        modelContext: true,
      } satisfies ConnectorAppView;
    });

    const logged = (
      view: Schema.Schema.Type<typeof StoredView>,
      request: string,
      answer: ConnectorAppAnswer,
    ) =>
      Effect.logInfo("connector app request").pipe(
        Effect.annotateLogs({
          botId: view.bot_id,
          connectorId: view.connector_id,
          viewId: view.id,
          request,
          outcome: answer._tag === "answer" ? "answered" : answer.reason,
        }),
        Effect.as(answer),
      );

    const callTool = Effect.fn("ConnectorApps.callTool")(function* (input: {
      readonly viewId: ConnectorAppViewId;
      readonly name: string;
      readonly arguments: Schema.JsonObject;
      readonly allowed: boolean;
    }) {
      const view = yield* found(input.viewId);
      // The bot's mode as it is now, not as it was when the app was opened;
      // asked again once the session is open, which may have waited.
      const permitted = input.allowed ? Effect.succeed(true) : runsUnasked(view.bot_id);
      if (!(yield* permitted)) {
        return yield* logged(view, `tools/call ${input.name}`, {
          _tag: "refused",
          reason: "needs-allow",
        });
      }
      const answer = yield* connectors.appCall({
        botId: view.bot_id,
        connectorId: view.connector_id,
        name: input.name,
        arguments: input.arguments,
        permitted,
      });
      return yield* logged(view, `tools/call ${input.name}`, answer);
    });

    const readResource = Effect.fn("ConnectorApps.readResource")(function* (input: {
      readonly viewId: ConnectorAppViewId;
      readonly uri: string;
    }) {
      const view = yield* found(input.viewId);
      const answer = yield* connectors.appRead({
        botId: view.bot_id,
        connectorId: view.connector_id,
        uri: input.uri,
      });
      return yield* logged(view, "resources/read", answer);
    });

    const setContext = Effect.fn("ConnectorApps.setContext")(function* (input: {
      readonly viewId: ConnectorAppViewId;
      readonly context: ConnectorAppContext;
    }) {
      const view = yield* found(input.viewId);
      const outcome = (outcome: ConnectorAppContextOutcome) =>
        Effect.logInfo("connector app request").pipe(
          Effect.annotateLogs({
            botId: view.bot_id,
            connectorId: view.connector_id,
            viewId: view.id,
            request: "ui/update-model-context",
            outcome: outcome._tag === "kept" ? "kept" : outcome.reason,
          }),
          Effect.as(outcome),
        );
      const { text, structured } = input.context;
      const data = structured === null ? null : yield* encodeObject(structured).pipe(Effect.orDie);
      // Its trust is the connector's: none once the bot no longer has it. The
      // grant is read and the context written in one transaction, so a grant
      // taken away meanwhile, which deletes the bot's contexts, comes after both.
      const kept = yield* Effect.gen(function* () {
        if (!(yield* connectors.granted({ botId: view.bot_id, connectorId: view.connector_id }))) {
          return false;
        }
        if (text.trim() === "" && structured === null) {
          yield* sql`DELETE FROM connector_app_contexts WHERE view_id = ${view.id}`;
          return true;
        }
        const room = Option.flatMap(yield* shownIn(view.id), (row) =>
          Option.fromNullishOr(row.room_id),
        );
        const { audience, roomId } = audienceColumns(
          Option.isSome(room) ? { _tag: "room", roomId: room.value } : { _tag: "conversation" },
        );
        const at = timeText(yield* DateTime.now);
        yield* sql`
          INSERT INTO connector_app_contexts (
            view_id, bot_id, audience, audience_room_id, text, structured_json, updated_at
          ) VALUES (${view.id}, ${view.bot_id}, ${audience}, ${roomId}, ${text}, ${data}, ${at})
          ON CONFLICT (view_id) DO UPDATE SET
            text = excluded.text, structured_json = excluded.structured_json,
            updated_at = excluded.updated_at, consumed_dispatch_id = NULL
        `;
        return true;
      }).pipe(sql.withTransaction, Effect.orDie);
      return yield* outcome(kept ? { _tag: "kept" } : { _tag: "refused", reason: "gone" });
    });

    return ConnectorApps.of({ record, open, callTool, readResource, setContext });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
