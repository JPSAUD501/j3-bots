// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppDocument } from "@j3-bots/connectors";
import {
  BotId,
  type ConnectorAppAnswer,
  ConnectorAppCsp,
  type ConnectorAppRef,
  ConnectorAppTool,
  type ConnectorAppView,
  ConnectorAppViewId,
  ConnectorId,
  EntryId,
  Label,
  MAX_CONNECTOR_APPS_PER_FOLD,
  MAX_LABEL_LENGTH,
  NotFound,
} from "@j3-bots/contracts";
import { TurnId } from "@j3-bots/engine-t3";
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
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import type { CallPlace } from "../turns/ConnectorSteps.ts";
import { sessionRecords } from "../turns/sessionRecords.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import type { OpenedApp } from "./Connectors.ts";
import { Connectors } from "./Connectors.ts";

/**
 * The apps connectors' tools open (`docs/architecture/server.md`, "Connector
 * apps", decision 0048): each one kept under the work fold of the turn whose
 * call opened it, and the requests its page makes, which go to the connector
 * as the bot's, under the bot's grant.
 */
export class ConnectorApps extends Context.Service<
  ConnectorApps,
  {
    /**
     * Keeps the app a bot's call opened, under its turn's work fold. A turn
     * without a fold (a routine's) shows no app, nor does one that already
     * shows `MAX_CONNECTOR_APPS_PER_FOLD`.
     */
    readonly record: (input: {
      readonly place: CallPlace;
      readonly botId: BotId;
      readonly input: Schema.JsonObject;
      readonly app: OpenedApp;
    }) => Effect.Effect<void>;
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
  }
>()("@j3-bots/server/connectors/ConnectorApps") {}

const TurnFold = Schema.Struct({
  engine_turn_id: TurnId,
  started_at: Time,
  finished_at: Schema.NullOr(Schema.String),
  work_fold_entry_id: Schema.NullOr(EntryId),
  id: Schema.String,
  bot_id: BotId,
  purpose: Schema.Literals(["main", "side"]),
});

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

/** What a tool's app is named by under its fold: its title, else its name. */
const toolLabel = (tool: ConnectorAppTool): string => {
  const title = tool.title?.trim() ?? "";
  return title.length > 0 && title.length <= MAX_LABEL_LENGTH ? title : tool.name;
};

export const layer = Layer.effect(
  ConnectorApps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const entries = yield* Entries;
    const workSteps = yield* WorkSteps;
    const ids = yield* Ids;
    const store = yield* BotStore;
    const connectors = yield* Connectors;
    const digest = yield* Digest.Digest;
    const records = sessionRecords(sql, entries, workSteps);

    const turnOf = SqlSchema.findOneOption({
      Request: Schema.Struct({ sessionId: Schema.String, turnId: TurnId }),
      Result: TurnFold,
      execute: ({ sessionId, turnId }) => sql`
        SELECT t.engine_turn_id, t.started_at, t.finished_at, t.work_fold_entry_id,
               s.id, s.bot_id, s.purpose
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

    /**
     * The fold the call's turn shows its work in: its own, or one opened for
     * it while it still runs, as the turn's first step would. A routine's
     * turn has none.
     */
    const foldOf = Effect.fn("ConnectorApps.foldOf")(function* (place: CallPlace) {
      const turn = yield* turnOf({ sessionId: place.sessionId, turnId: place.turnId });
      if (Option.isNone(turn) || turn.value.purpose === "side") return Option.none<EntryId>();
      if (turn.value.work_fold_entry_id !== null) return Option.some(turn.value.work_fold_entry_id);
      if (turn.value.finished_at !== null) return Option.none<EntryId>();
      return Option.some(
        yield* records.foldOf(
          { id: turn.value.id, bot_id: turn.value.bot_id, purpose: turn.value.purpose },
          turn.value,
          { _tag: "running" },
        ),
      );
    });

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
          const fold = yield* foldOf(input.place);
          if (Option.isNone(fold)) return false;
          const found = yield* entries.find(fold.value);
          if (Option.isNone(found) || found.value.entry._tag !== "work-fold") return false;
          const entry = found.value.entry;
          if (entry.apps.length >= MAX_CONNECTOR_APPS_PER_FOLD) return false;
          const digestKey = yield* keepDocument(app.document);
          yield* sql`
              INSERT INTO connector_app_views (
                id, entry_id, bot_id, connector_id, connector_name, tool_json, input_json,
                result_json, document_digest, csp_json, created_at
              ) VALUES (
                ${viewId}, ${fold.value}, ${input.botId}, ${app.connectorId}, ${app.connector},
                ${tool}, ${arguments_}, ${result}, ${digestKey}, ${csp}, ${at}
              )
            `;
          const ref: ConnectorAppRef = {
            viewId,
            connectorId: app.connectorId,
            connector: app.connector,
            tool: toolLabel(app.tool),
          };
          yield* entries.update({ ...entry, apps: [...entry.apps, ref] });
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

    return ConnectorApps.of({ record, open, callTool, readResource });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
