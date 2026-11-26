// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type ConnectorAppAnswer,
  type ConnectorAppRef,
  MAX_CONNECTOR_APP_BYTES,
  MCP_APP_MIME_TYPE,
  type WorkFoldEntry,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Bots } from "../bots/Bots.ts";
import { fakeConnector, reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  eventually,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { ToolLists } from "../tools/ToolLists.ts";
import { ConnectorApps } from "./ConnectorApps.ts";

const domain = TestDomain.layer.pipe(Layer.provide(reachFakes));

/** Each test sets up a vault, whose key takes a while to derive, and talks to a server over a socket. */
const SLOW = 20_000;

const STOCK = "<p>Ridge 7: 2 in stock</p>";

/**
 * A shop's connector: `stock` opens an app, `hold` is the app's alone, and
 * `refund` the bot's alone. `document` is what its app's address reads as.
 */
const shop = (document: string = STOCK) =>
  fakeConnector({
    name: "Wheelhouse",
    tools: [
      {
        name: "stock",
        description: "What the shop has in stock.",
        inputSchema: { type: "object", properties: { model: { type: "string" } } },
        _meta: { ui: { resourceUri: "ui://wheelhouse/stock" } },
      },
      { name: "hold", _meta: { ui: { visibility: ["app"] } } },
      { name: "refund", _meta: { ui: { visibility: ["model"] } } },
    ],
    resources: (uri) =>
      uri === "ui://wheelhouse/stock"
        ? [
            {
              uri,
              mimeType: MCP_APP_MIME_TYPE,
              text: document,
              _meta: {
                ui: {
                  csp: { connectDomains: ["https://api.wheelhouse.example", "http://10.0.0.2"] },
                },
              },
            },
          ]
        : undefined,
  });

/** A bot working on a message from the operator. */
const working = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Is the Ridge 7 in stock?");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, turnId };
  });

/** Sets the bot's permission mode, as the operator would. */
const setMode = (
  botId: Parameters<typeof conversation>[0],
  permissionMode: "full-access" | "supervised",
) =>
  Effect.flatMap(Bots, (bots) =>
    bots.update({ commandId: command(), botId, changes: { permissionMode } }),
  );

/** The bot calls `tool` in its running turn, which the engine records first. */
const callInTurn = (
  bot: { readonly session: SessionId; readonly turnId: TurnId },
  tool: string,
  args: Record<string, string>,
  requestId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: bot.session,
      turnId: bot.turnId,
      tool,
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId,
      sessionId: bot.session,
      tool,
      arguments: args,
    });
  });

/** The turn's work fold, once it shows an app. */
const foldWithApp = (botId: Parameters<typeof conversation>[0]) =>
  eventually(
    conversation(botId).pipe(
      Effect.map((entries) =>
        Option.fromNullishOr(
          entries.find(
            (entry): entry is WorkFoldEntry => entry._tag === "work-fold" && entry.apps.length > 0,
          ),
        ),
      ),
    ),
  );

const onlyApp = (fold: WorkFoldEntry): ConnectorAppRef => {
  const [app, ...more] = fold.apps;
  if (app === undefined || more.length > 0) throw new Error("The fold shows one app");
  return app;
};

it.effect(
  "shows the app a connector's tool opened under the turn's work, with the call it came from",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      assert.strictEqual(reply._tag, "text");

      const app = onlyApp(yield* foldWithApp(ana.bot.id));
      assert.deepStrictEqual(
        { connector: app.connector, tool: app.tool },
        { connector: "Wheelhouse", tool: "stock" },
      );
      const view = yield* (yield* ConnectorApps).open(app.viewId);
      assert.strictEqual(view.botId, ana.bot.id);
      assert.strictEqual(view.html, STOCK);
      assert.deepStrictEqual(view.input, { model: "Ridge 7" });
      assert.deepStrictEqual(view.result, {
        content: [{ type: "text", text: "stock answered" }],
        isError: false,
      });
      // Of what its server declared, only an https host of the internet.
      assert.deepStrictEqual(view.csp, {
        connectDomains: ["https://api.wheelhouse.example"],
        resourceDomains: [],
        baseUriDomains: [],
      });
      assert.strictEqual(view.tool.name, "stock");
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "runs an app's calls as its bot's, only tools open to apps, and only while the bot has the connector",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      yield* setMode(ana.bot.id, "full-access");
      // The app's own tool is never offered to the bot.
      const { tools } = yield* (yield* ToolLists).list(ana.session);
      const offered = tools.map((tool) => tool.name);
      assert.include(offered, "wheelhouse__refund");
      assert.notInclude(offered, "wheelhouse__hold");

      yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      const { viewId } = onlyApp(yield* foldWithApp(ana.bot.id));
      const apps = yield* ConnectorApps;

      const hold = { viewId, name: "hold", arguments: { model: "Ridge 7" } };
      const answered: ConnectorAppAnswer = {
        _tag: "answer",
        result: { content: [{ type: "text", text: "hold answered" }], isError: false },
      };
      // In full access, the bot's own calls run without asking, and so do its app's.
      assert.deepStrictEqual(yield* apps.callTool({ ...hold, allowed: false }), answered);

      // Out of full access, as of the next call, even in an app opened before: only what the operator allows.
      yield* setMode(ana.bot.id, "supervised");
      assert.deepStrictEqual(yield* apps.callTool({ ...hold, allowed: false }), {
        _tag: "refused",
        reason: "needs-allow",
      });
      assert.deepStrictEqual(yield* apps.callTool({ ...hold, allowed: true }), answered);

      for (const name of ["refund", "delete_everything"]) {
        assert.deepStrictEqual(
          yield* apps.callTool({ viewId, name, arguments: {}, allowed: true }),
          { _tag: "refused", reason: "not-for-apps" },
        );
      }

      yield* connector.grant([]);
      assert.deepStrictEqual(yield* apps.callTool({ ...hold, allowed: true }), {
        _tag: "refused",
        reason: "gone",
      });
      assert.deepStrictEqual(
        (yield* connector.calls).map((call) => call.name),
        ["stock", "hold", "hold"],
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "answers the bot and shows no app when the app's document is larger than an app may be",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop(`<p>${"x".repeat(MAX_CONNECTOR_APP_BYTES)}</p>`);
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      assert.strictEqual(reply._tag, "text");
      if (reply._tag === "text") assert.include(reply.text, "stock answered");
      const folds = (yield* conversation(ana.bot.id)).filter(
        (entry): entry is WorkFoldEntry => entry._tag === "work-fold",
      );
      assert.deepStrictEqual(
        folds.flatMap((fold) => fold.apps),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);
