// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ConnectorAppAnswer,
  type ConnectorAppEntry,
  type Entry,
  MAX_CONNECTOR_APP_BYTES,
  MAX_CONNECTOR_APPS_PER_TURN,
  MCP_APP_MIME_TYPE,
} from "@j3-bots/contracts";
import { APP_SHOWN_LINE } from "@j3-bots/prompts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Bots } from "../bots/Bots.ts";
import { fakeConnector, reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  finishRunning,
  flushed,
  nextTurn,
  received,
  roomEntries,
  roomOf,
  sendInRoom,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { ToolLists } from "../tools/ToolLists.ts";
import { ConnectorApps } from "./ConnectorApps.ts";
import { Connectors } from "./Connectors.ts";

const domain = TestDomain.layer.pipe(Layer.provide(reachFakes));

/** Each test sets up a vault, whose key takes a while to derive, and talks to a server over a socket. */
const SLOW = 20_000;

const STOCK = "<p>Ridge 7: 2 in stock</p>";

/**
 * A shop's connector: `stock` opens an app, `hold` is the app's alone, and
 * `refund` the bot's alone. `document` is what its app's address reads as;
 * its tools answer once `answered` settles, at once without it.
 */
const shop = (document: string = STOCK, answered?: Promise<void>) =>
  fakeConnector({
    name: "Wheelhouse",
    ...(answered === undefined
      ? {}
      : {
          answer: (name: string) => ({
            _tag: "result" as const,
            text: `${name} answered`,
            after: answered,
          }),
        }),
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

/** The apps among `entries`, in order. */
const appsIn = (entries: ReadonlyArray<Entry>) =>
  entries.filter((entry): entry is ConnectorAppEntry => entry._tag === "connector-app");

/** The one app the bot's conversation shows. */
const onlyApp = (botId: Parameters<typeof conversation>[0]) =>
  Effect.gen(function* () {
    const [app, ...more] = appsIn(yield* conversation(botId));
    if (app === undefined || more.length > 0) throw new Error("The conversation shows one app");
    return app.app;
  });

/** The bot says `text` in its running turn. */
const sayInTurn = (bot: { readonly session: SessionId; readonly turnId: TurnId }, text: string) =>
  Effect.gen(function* () {
    const args = { text, done: false };
    yield* (yield* TestEngineControl).toolCall({
      sessionId: bot.session,
      turnId: bot.turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: `say-${text}`,
      sessionId: bot.session,
      tool: "say",
      arguments: args,
    });
  });

/** What a connector's tool answered the bot. */
const textOf = (reply: ToolCallResponse) => {
  if (reply._tag !== "text") throw new Error(`The tool answered with ${reply._tag}`);
  return reply.text;
};

it.effect(
  "shows the app a connector's tool opened in the bot's reply, where its call happened",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      // The bot learns its user sees the app, so it doesn't repeat it.
      assert.include(textOf(reply), "stock answered");
      assert.include(textOf(reply), APP_SHOWN_LINE);
      yield* sayInTurn(ana, "Two left, both in red.");

      // The operator's message, the app, then what the bot said after the call.
      const shown = (yield* conversation(ana.bot.id)).flatMap((entry) =>
        entry._tag === "message" || entry._tag === "connector-app"
          ? [
              entry._tag === "message"
                ? entry.text
                : `app: ${entry.app.connector} ${entry.app.tool}`,
            ]
          : [],
      );
      assert.deepStrictEqual(shown, [
        "Is the Ridge 7 in stock?",
        "app: Wheelhouse stock",
        "Two left, both in red.",
      ]);

      const app = yield* onlyApp(ana.bot.id);
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
  "answers the bot and shows no app when its call comes back after the turn ended",
  () =>
    Effect.gen(function* () {
      let answer = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const connector = yield* shop(STOCK, answered);
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      const call = yield* Effect.forkChild(
        callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1"),
      );
      yield* until(Effect.map(connector.calls, (calls) => calls.length > 0));

      // The turn ends while the connector is still answering, as when the operator stops it.
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: ana.session,
        turnId: ana.turnId,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(ana.bot.id);
      answer();

      const reply = yield* Fiber.join(call);
      assert.include(textOf(reply), "stock answered");
      assert.notInclude(textOf(reply), APP_SHOWN_LINE);
      assert.deepStrictEqual(appsIn(yield* conversation(ana.bot.id)), []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "shows the app of a room's turn in the room, not in the bot's conversation",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const room = yield* roomOf(bot.id);
      yield* connector.grant([bot.id]);
      yield* sendInRoom(bot.id, room.id, "Ana, is the Ridge 7 in stock?");
      const turnId = yield* nextTurn(bot.id);

      yield* callInTurn({ session, turnId }, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");

      const inRoom = appsIn(yield* roomEntries(room.id));
      assert.deepStrictEqual(
        inRoom.map((entry) => entry.app.tool),
        ["stock"],
      );
      assert.deepStrictEqual(appsIn(yield* conversation(bot.id)), []);
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
      const { viewId } = yield* onlyApp(ana.bot.id);
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
  "shows at most a turn's share of apps, and tells the bot only of those it shows",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const replies: Array<string> = [];
      for (let call = 0; call <= MAX_CONNECTOR_APPS_PER_TURN; call++) {
        const reply = yield* callInTurn(
          ana,
          "wheelhouse__stock",
          { model: "Ridge 7" },
          `call-${call}`,
        );
        replies.push(textOf(reply));
      }

      assert.strictEqual(
        appsIn(yield* conversation(ana.bot.id)).length,
        MAX_CONNECTOR_APPS_PER_TURN,
      );
      assert.deepStrictEqual(
        replies.map((text) => [text.includes("stock answered"), text.includes(APP_SHOWN_LINE)]),
        [...Array.from({ length: MAX_CONNECTOR_APPS_PER_TURN }, () => [true, true]), [true, false]],
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
      assert.include(textOf(reply), "stock answered");
      assert.notInclude(textOf(reply), APP_SHOWN_LINE);
      assert.deepStrictEqual(appsIn(yield* conversation(ana.bot.id)), []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "carries what an app last set as context into its bot's next turn, once, and wakes nobody",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      const { viewId } = yield* onlyApp(ana.bot.id);
      const apps = yield* ConnectorApps;

      const picked = (color: string) =>
        apps.setContext({
          viewId,
          context: { text: `Picked the Ridge 7 in ${color}.`, structured: { color } },
        });
      assert.deepStrictEqual(yield* picked("red"), { _tag: "kept" });
      assert.deepStrictEqual(yield* picked("blue"), { _tag: "kept" });
      const first = yield* finishRunning(ana.bot.id);
      // Setting it starts no turn.
      yield* flushed(ana.bot.id);
      assert.strictEqual((yield* received(ana.session)).length, 1);

      yield* sendToBot(ana.bot.id, "Hold it for me.");
      const second = yield* finishRunning(ana.bot.id, first);
      yield* sendToBot(ana.bot.id, "Thanks.");
      yield* finishRunning(ana.bot.id, second);

      // Only the latest, as the connector's content, and only in the next turn.
      const sent = (yield* received(ana.session)).map(({ text }) => text);
      assert.deepStrictEqual(
        sent.map((text) => [
          text.includes("Picked the Ridge 7 in red."),
          text.includes("Picked the Ridge 7 in blue."),
          text.includes('{"color":"blue"}'),
        ]),
        [
          [false, false, false],
          [false, true, true],
          [false, false, false],
        ],
      );
      assert.include(sent[1], 'source="app"');
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "takes back an app's context when it sets an empty one, and keeps none once the bot loses the connector, even when it gets it back",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      const { viewId, connectorId } = yield* onlyApp(ana.bot.id);
      const apps = yield* ConnectorApps;

      yield* apps.setContext({ viewId, context: { text: "Picked size M.", structured: null } });
      assert.deepStrictEqual(
        yield* apps.setContext({ viewId, context: { text: "", structured: null } }),
        { _tag: "kept" },
      );
      // What it set last, unread when the operator takes the connector away,
      // goes with it, and giving the connector back does not bring it back.
      yield* apps.setContext({ viewId, context: { text: "Picked size S.", structured: null } });
      yield* connector.grant([]);
      assert.deepStrictEqual(
        yield* apps.setContext({ viewId, context: { text: "Picked size L.", structured: null } }),
        { _tag: "refused", reason: "gone" },
      );
      yield* connector.grant([ana.bot.id]);
      assert.isTrue(yield* (yield* Connectors).granted({ botId: ana.bot.id, connectorId }));
      const first = yield* finishRunning(ana.bot.id);
      yield* sendToBot(ana.bot.id, "Hold it for me.");
      yield* finishRunning(ana.bot.id, first);

      for (const { text } of yield* received(ana.session)) {
        assert.notInclude(text, "Picked size");
      }
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "keeps no app's context for its bot once its connector is removed",
  () =>
    Effect.gen(function* () {
      const connector = yield* shop();
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      yield* callInTurn(ana, "wheelhouse__stock", { model: "Ridge 7" }, "call-1");
      const { viewId, connectorId } = yield* onlyApp(ana.bot.id);

      yield* (yield* ConnectorApps).setContext({
        viewId,
        context: { text: "Picked size S.", structured: null },
      });
      yield* (yield* Connectors).remove({ commandId: CommandId.make("remove-shop"), connectorId });
      const first = yield* finishRunning(ana.bot.id);
      yield* sendToBot(ana.bot.id, "Hold it for me.");
      yield* finishRunning(ana.bot.id, first);

      for (const { text } of yield* received(ana.session)) {
        assert.notInclude(text, "Picked size");
      }
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);
