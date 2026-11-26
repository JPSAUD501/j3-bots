// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { Bot, BotId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { MANAGEMENT_NOTES, MANAGEMENT_REFUSED } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Bots } from "../bots/Bots.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { Entries } from "../entries/Entries.ts";
import { Layout } from "../Layout.ts";
import { Skills } from "../skills/Skills.ts";
import * as TestDomain from "../testing/domain.ts";
import { TestGitHost } from "../testing/gitHost.ts";
import { unresolvable } from "../testing/oauth.ts";
import { command, createBot, engineSession, nextTurn, sendToBot } from "../testing/turns.ts";
import { BotTools } from "./BotTools.ts";
import type { ToolCallResponse } from "./protocol.ts";

const domain = TestDomain.layer.pipe(Layer.provide(unresolvable));
const withGitHost = TestDomain.layerWithGitHost.pipe(Layer.provide(unresolvable));

/** A bot in a turn answering the operator, whose calls the engine records as it makes them. */
interface Working {
  readonly bot: Bot;
  readonly session: SessionId;
  readonly turnId: TurnId;
}

const working = (bot: Bot) =>
  Effect.gen(function* () {
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Set things up for the team.");
    return { bot, session, turnId: yield* nextTurn(bot.id) } satisfies Working;
  });

const primary = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { primary: true },
    });
    return bot;
  });

let requests = 0;

/** The bot calls `tool` in its turn, which the engine records first, as the harness ran it. */
const call = (bot: Working, tool: string, args: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: bot.session,
      turnId: bot.turnId,
      tool,
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `request-${++requests}`,
      sessionId: bot.session,
      tool,
      arguments: args,
    });
  });

const AnswerJson = Schema.Record(Schema.String, Schema.Json);
const decodeAnswer = Schema.decodeUnknownSync(AnswerJson);

const resultOf = (response: ToolCallResponse) =>
  response._tag === "result"
    ? decodeAnswer(response.value)
    : assert.fail(`expected a result, got ${JSON.stringify(response)}`);

const refusalOf = (response: ToolCallResponse) =>
  response._tag === "refused"
    ? response.message
    : assert.fail(`expected a refusal, got ${JSON.stringify(response)}`);

const ServerAnswer = Schema.Struct({
  server: Schema.Struct({
    id: Schema.String,
    bots: Schema.Union([Schema.Literal("every-bot"), Schema.Array(Schema.String)]),
    lastChange: Schema.Struct({ by: Schema.Json, at: Schema.String }),
  }),
  note: Schema.String,
});
const serverOf = (response: ToolCallResponse) =>
  Schema.decodeUnknownSync(ServerAnswer)(resultOf(response));

const remote = (name: string, extra: Record<string, Schema.Json> = {}) => ({
  url: `https://${name.toLowerCase()}.example/mcp`,
  name,
  ...extra,
});

const skillText = (name: string, description = "When filing expenses") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nThe steps.\n`;

it.effect("lets the primary bot manage every MCP server, and another bot only its own", () =>
  Effect.gen(function* () {
    const ada = yield* working(yield* primary("Ada"));
    const ben = yield* working(yield* createBot("Ben"));

    // A bot's server is its own; the primary bot's is every bot's.
    const bens = serverOf(yield* call(ben, "add_mcp_server", remote("Tracker")));
    assert.deepStrictEqual(bens.server.bots, [ben.bot.id]);
    assert.deepStrictEqual(bens.server.lastChange.by, { bot: ben.bot.id });
    const adas = serverOf(yield* call(ada, "add_mcp_server", remote("Wiki")));
    assert.strictEqual(adas.server.bots, "every-bot");

    // Only the primary bot picks who else uses a server.
    assert.strictEqual(
      refusalOf(yield* call(ben, "add_mcp_server", remote("Calendar", { scope: "every-bot" }))),
      MANAGEMENT_REFUSED.primaryOnly,
    );
    assert.strictEqual(
      refusalOf(
        yield* call(ben, "set_mcp_server_bots", { server: bens.server.id, bots: "every-bot" }),
      ),
      MANAGEMENT_REFUSED.primaryOnly,
    );
    // Ben uses the primary bot's server, but cannot change or remove it.
    assert.strictEqual(
      refusalOf(yield* call(ben, "update_mcp_server", { server: adas.server.id, name: "Mine" })),
      MANAGEMENT_REFUSED.notYours("Wiki"),
    );
    assert.strictEqual(
      refusalOf(yield* call(ben, "remove_mcp_server", { server: adas.server.id })),
      MANAGEMENT_REFUSED.notYours("Wiki"),
    );
    // His own he changes.
    assert.strictEqual(
      resultOf(yield* call(ben, "update_mcp_server", { server: bens.server.id, name: "Issues" }))[
        "note"
      ],
      MANAGEMENT_NOTES.failing,
    );

    // The primary bot gives Ben's server to itself too: no longer Ben's alone.
    const shared = serverOf(
      yield* call(ada, "set_mcp_server_bots", {
        server: bens.server.id,
        bots: [ada.bot.id, ben.bot.id],
      }),
    );
    assert.sameMembers([...shared.server.bots], [ada.bot.id, ben.bot.id]);
    assert.deepStrictEqual(shared.server.lastChange.by, { bot: ada.bot.id });
    assert.strictEqual(
      refusalOf(yield* call(ben, "remove_mcp_server", { server: bens.server.id })),
      MANAGEMENT_REFUSED.notYours("Issues"),
    );

    // A bot lists only the servers it uses; the primary bot lists every one.
    const own = serverOf(
      yield* call(ada, "add_mcp_server", remote("Notes", { scope: { bot: ada.bot.id } })),
    );
    const listedBy = (bot: Working) =>
      Effect.map(call(bot, "list_mcp_servers", {}), (response) =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            servers: Schema.Array(Schema.Struct({ id: Schema.String, mayChange: Schema.Boolean })),
          }),
        )(resultOf(response)).servers.map(({ id, mayChange }) => [id, mayChange]),
      );
    assert.sameDeepMembers(yield* listedBy(ben), [
      [bens.server.id, false],
      [adas.server.id, false],
    ]);
    assert.sameDeepMembers(yield* listedBy(ada), [
      [bens.server.id, true],
      [adas.server.id, true],
      [own.server.id, true],
    ]);

    resultOf(yield* call(ada, "remove_mcp_server", { server: bens.server.id }));
    const left = (yield* (yield* Connectors).listed).map(({ connector }) => connector.name);
    assert.sameMembers(left, ["Wiki", "Notes"]);
  }).pipe(Effect.scoped, Effect.provide(domain)),
);

it.effect(
  "adds a server that needs a sign-in and asks the operator for it in the bot's conversation",
  () =>
    Effect.gen(function* () {
      const ada = yield* working(yield* primary("Ada"));

      const added = serverOf(yield* call(ada, "add_mcp_server", { gallery: "curated:linear" }));
      assert.strictEqual(added.note, MANAGEMENT_NOTES.signInPending);
      const cards = (yield* (yield* Entries).latest(
        { _tag: "conversation", botId: ada.bot.id },
        50,
      )).flatMap((entry) => (entry._tag === "connector-auth" ? [entry.status] : []));
      assert.deepStrictEqual(cards, ["pending"]);

      // One whose app the operator registers is theirs to add.
      assert.strictEqual(
        refusalOf(yield* call(ada, "add_mcp_server", { gallery: "curated:google-gmail" })),
        MANAGEMENT_REFUSED.ownApp,
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
);

/** Where a skill's `SKILL.md` is, in the shared skills or in a bot's workspace. */
const skillFile = (scope: "shared" | BotId, name: string) =>
  Effect.gen(function* () {
    const layout = yield* Layout;
    const path = yield* Path.Path;
    const folder =
      scope === "shared" ? layout.sharedSkills : path.join(layout.workspace(scope), "skills");
    return path.join(folder, name, "SKILL.md");
  });

it.effect(
  "saves and removes skills, a bot its own and the primary bot every bot's, and links them for the harnesses",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const control = yield* TestEngineControl;
      const ada = yield* working(yield* primary("Ada"));
      const ben = yield* working(yield* createBot("Ben"));
      const linkedBefore = yield* control.sharedSkillLinks;

      resultOf(yield* call(ben, "save_skill", { name: "expenses", text: skillText("expenses") }));
      assert.strictEqual(
        yield* fs.readFileString(yield* skillFile(ben.bot.id, "expenses")),
        skillText("expenses"),
      );
      // The bot's harness lists it from its workspace, without a restart.
      assert.include(yield* control.botSkillLinks, (yield* Layout).workspace(ben.bot.id));
      assert.strictEqual(
        refusalOf(
          yield* call(ben, "save_skill", {
            name: "triage",
            text: skillText("triage"),
            scope: "every-bot",
          }),
        ),
        MANAGEMENT_REFUSED.primaryOnly,
      );

      // The primary bot shares one, which every harness home links at once.
      resultOf(
        yield* call(ada, "save_skill", {
          name: "triage",
          text: skillText("triage"),
          scope: "every-bot",
        }),
      );
      assert.strictEqual(yield* control.sharedSkillLinks, linkedBefore + 1);
      // A bot's skill cannot take a shared one's name, which Claude Code would list once.
      assert.strictEqual(
        refusalOf(yield* call(ben, "save_skill", { name: "triage", text: skillText("triage") })),
        MANAGEMENT_REFUSED.skillNameTaken("triage"),
      );
      // Frontmatter that names another skill is refused.
      assert.strictEqual(
        refusalOf(yield* call(ben, "save_skill", { name: "notes", text: skillText("other") })),
        MANAGEMENT_REFUSED.skillText,
      );
      assert.strictEqual(
        refusalOf(yield* call(ben, "remove_skill", { name: "triage", scope: "every-bot" })),
        MANAGEMENT_REFUSED.primaryOnly,
      );

      // The primary bot changes another bot's skills too, and the records say who.
      resultOf(
        yield* call(ada, "save_skill", {
          name: "expenses",
          text: skillText("expenses", "When filing expenses, in euros"),
          scope: { bot: ben.bot.id },
        }),
      );
      const listed = (yield* (yield* Skills).list).map((skill) => [
        skill.scope._tag === "all-bots" ? "shared" : skill.scope.botId,
        skill.name,
        skill.description,
        skill.lastChange?.by,
      ]);
      assert.includeDeepMembers(listed, [
        ["shared", "triage", "When filing expenses", { _tag: "bot", botId: ada.bot.id }],
        [
          ben.bot.id,
          "expenses",
          "When filing expenses, in euros",
          { _tag: "bot", botId: ada.bot.id },
        ],
      ]);

      resultOf(yield* call(ada, "remove_skill", { name: "triage", scope: "every-bot" }));
      resultOf(yield* call(ben, "remove_skill", { name: "expenses" }));
      assert.isFalse(yield* fs.exists(yield* skillFile("shared", "triage")));
      assert.isFalse(yield* fs.exists(yield* skillFile(ben.bot.id, "expenses")));
      // J3 Bots' own stay.
      assert.strictEqual(
        refusalOf(yield* call(ada, "remove_skill", { name: "j3-routines", scope: "every-bot" })),
        MANAGEMENT_REFUSED.skillShipped,
      );

      // A folder of the bot's workspace is saved with what it holds; one reached through a link,
      // here into the primary bot's workspace, is not.
      const path = yield* Path.Path;
      const layout = yield* Layout;
      const own = path.join(layout.workspace(ben.bot.id), "files", "invoices");
      yield* fs.makeDirectory(path.join(own, "scripts"), { recursive: true });
      yield* fs.writeFileString(path.join(own, "SKILL.md"), skillText("invoices"));
      yield* fs.writeFileString(path.join(own, "scripts", "total.sh"), "echo total\n");
      resultOf(yield* call(ben, "save_skill", { name: "invoices", folder: "files/invoices" }));
      assert.strictEqual(
        yield* fs.readFileString(
          path.join(layout.workspace(ben.bot.id), "skills", "invoices", "scripts", "total.sh"),
        ),
        "echo total\n",
      );
      const elsewhere = path.join(layout.workspace(ada.bot.id), "files", "notes");
      yield* fs.makeDirectory(path.join(elsewhere, "leak"), { recursive: true });
      yield* fs.writeFileString(path.join(elsewhere, "leak", "SKILL.md"), skillText("leak"));
      yield* fs.symlink(elsewhere, path.join(layout.workspace(ben.bot.id), "notes"));
      assert.strictEqual(
        refusalOf(yield* call(ben, "save_skill", { name: "leak", folder: "notes/leak" })),
        MANAGEMENT_REFUSED.notASkill("notes/leak goes through a link"),
      );
      assert.isFalse(yield* fs.exists(yield* skillFile(ben.bot.id, "leak")));
      // Nor is a folder of a workspace the bot replaced with a link to the primary bot's.
      const bens = layout.workspace(ben.bot.id);
      yield* fs.rename(bens, `${bens}-moved`);
      yield* fs.symlink(layout.workspace(ada.bot.id), bens);
      assert.strictEqual(
        refusalOf(yield* call(ben, "save_skill", { name: "leak", folder: "files/notes/leak" })),
        MANAGEMENT_REFUSED.notASkill("files/notes/leak goes through a link"),
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
);

it.effect(
  "installs a skill from a git repository at the commit it was fetched at, and nothing it links to",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* TestGitHost;
      const first = host.commit({
        "skills/triage/SKILL.md": skillText("triage", "When triaging issues"),
        "skills/triage/scripts/label.sh": "echo label\n",
        "skills/review/SKILL.md": skillText("review", "When reviewing a change"),
        "skills/linked/SKILL.md": skillText("linked"),
        "skills/linked/secrets": { link: "/etc/passwd" },
      });
      const ada = yield* working(yield* primary("Ada"));
      const ben = yield* working(yield* createBot("Ben"));

      const Installed = Schema.Struct({
        skill: Schema.Struct({
          scope: Schema.Json,
          files: Schema.Number,
          source: Schema.Struct({ commit: Schema.String, path: Schema.String }),
        }),
      });
      const installed = yield* Schema.decodeUnknownEffect(Installed)(
        resultOf(
          yield* call(ben, "install_skill", {
            repository: host.url,
            path: "skills/triage",
            ref: "main",
          }),
        ),
      );
      assert.deepStrictEqual(installed.skill.source, { commit: first, path: "skills/triage" });
      assert.strictEqual(installed.skill.files, 1);
      assert.strictEqual(installed.skill.scope, "this-bot");
      const file = yield* skillFile(ben.bot.id, "triage");
      assert.include(yield* fs.readFileString(file), "When triaging issues");

      // A later commit on the branch reaches nobody until the skill is installed again.
      host.commit({ "skills/triage/SKILL.md": skillText("triage", "When triaging, changed") });
      assert.include(yield* fs.readFileString(file), "When triaging issues");
      // Installed at the first commit by its id, for every bot, by the primary bot.
      const shared = yield* Schema.decodeUnknownEffect(Installed)(
        resultOf(
          yield* call(ada, "install_skill", {
            repository: host.url,
            path: "skills/review",
            ref: first,
            scope: "every-bot",
          }),
        ),
      );
      assert.strictEqual(shared.skill.source.commit, first);
      assert.strictEqual(shared.skill.scope, "every-bot");

      // A folder holding a link is refused whole, and nothing is written.
      assert.strictEqual(
        refusalOf(
          yield* call(ben, "install_skill", {
            repository: host.url,
            path: "skills/linked",
            ref: "main",
          }),
        ),
        MANAGEMENT_REFUSED.notASkill("secrets is a link"),
      );
      assert.isFalse(yield* fs.exists(yield* skillFile(ben.bot.id, "linked")));
      // A name the repository does not have is no branch, tag or commit.
      assert.include(
        refusalOf(
          yield* call(ben, "install_skill", {
            repository: host.url,
            path: "skills/triage",
            ref: "nowhere",
            name: "other",
          }),
        ),
        "no branch, tag or commit",
      );
    }).pipe(Effect.scoped, Effect.provide(withGitHost)),
);
