// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type BotTemplate,
  BotTemplate as BotTemplateSchema,
  CommandId,
  MAX_TEMPLATE_FILE_SIZE,
  ModelId,
  ProviderId,
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Layout } from "../Layout.ts";
import { Memory } from "../memory/Memory.ts";
import { Routines } from "../routines/Routines.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import * as TestDomain from "../testing/domain.ts";
import { BotStore } from "./BotStore.ts";
import { Bots } from "./Bots.ts";
import { Templates } from "./Templates.ts";

let commands = 0;
const command = () => CommandId.make(`template-command-${++commands}`);

const TRIAGE = "---\nname: triage\ndescription: Sort the inbox.\n---\n\nRead each message.\n";

const template = (overrides: Partial<BotTemplate> = {}): BotTemplate => ({
  format: TEMPLATE_FORMAT,
  version: TEMPLATE_VERSION,
  profile: {
    name: "Scout",
    title: "Research",
    avatar: { shape: "bean", color: "honey" },
    job: "Finds sources and summarizes them.",
  },
  model: TestDomain.DEFAULT_MODEL,
  permissionMode: "supervised",
  skills: [{ name: "triage", text: TRIAGE }],
  routines: [
    {
      name: "Morning digest",
      instruction: "Summarize what came in overnight. Send it if there is anything.",
      trigger: { _tag: "schedule", cron: "0 9 * * 1-5" },
    },
    {
      name: "Deploys",
      instruction: "Tell me when a deploy fails.",
      trigger: { _tag: "webhook" },
    },
  ],
  ...overrides,
});

const createFrom = (from: Parameters<Bots["Service"]["createFromTemplate"]>[0]["from"]) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    return yield* (yield* Bots).createFromTemplate({ commandId: command(), from });
  });

it.effect("builds a template from what the bot is and does, and nothing it has lived", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const routines = yield* Routines;
    const memory = yield* Memory;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.adjust("1 second");
    const bot = yield* bots.create({
      commandId: command(),
      draft: { name: "Ana", title: "Inbox", job: "Keeps the inbox at zero." },
    });
    yield* memory.remember({
      botId: bot.id,
      fact: "The operator's bank PIN hint is the cat's name",
      tier: "pinned",
      scope: "bot",
    });
    const workspace = layout.workspace(bot.id);
    yield* fs.writeFileString(path.join(workspace, "files", "report.md"), "# Private report");
    const operator = { _tag: "operator" } as const;
    yield* routines.create({
      commandId: command(),
      botId: bot.id,
      draft: {
        name: "Digest",
        instruction: "Summarize the inbox.",
        trigger: { _tag: "schedule", cron: "0 9 * * *", timeZone: "America/Sao_Paulo" },
      },
      author: operator,
    });
    const webhook = yield* routines.create({
      commandId: command(),
      botId: bot.id,
      draft: { name: "Deploys", instruction: "Watch deploys.", trigger: { _tag: "webhook" } },
      author: operator,
    });
    const now = yield* DateTime.now;
    yield* routines.create({
      commandId: command(),
      botId: bot.id,
      draft: {
        name: "Dentist",
        instruction: "Remind me of the dentist.",
        trigger: { _tag: "once", at: DateTime.add(now, { days: 2 }) },
      },
      author: operator,
    });
    const skills = path.join(workspace, "skills");
    yield* fs.makeDirectory(path.join(skills, "triage"), { recursive: true });
    yield* fs.writeFileString(path.join(skills, "triage", "SKILL.md"), TRIAGE);
    // A skill whose SKILL.md is a link to the bot's memory, a folder that is a
    // link, and a folder no skill name fits: none is read.
    yield* fs.makeDirectory(path.join(skills, "notes"));
    yield* fs.symlink(
      path.join(layout.botMemory(bot.id), "profile.md"),
      path.join(skills, "notes", "SKILL.md"),
    );
    yield* fs.symlink(path.join(workspace, "files"), path.join(skills, "linked"));
    yield* fs.makeDirectory(path.join(skills, "..hidden"));
    yield* fs.writeFileString(path.join(skills, "..hidden", "SKILL.md"), TRIAGE);

    const made = yield* (yield* Templates).template(bot.id);

    assert.deepStrictEqual(made.profile, {
      name: "Ana",
      title: "Inbox",
      avatar: bot.profile.avatar,
      job: "Keeps the inbox at zero.",
    });
    assert.deepStrictEqual(made.skills, [{ name: "triage", text: TRIAGE }]);
    assert.sameDeepMembers(
      made.routines.map((routine) => routine.trigger),
      [{ _tag: "schedule", cron: "0 9 * * *" }, { _tag: "webhook" }],
    );
    const text = JSON.stringify(yield* Schema.encodeEffect(BotTemplateSchema)(made));
    assert.notInclude(text, "bank PIN");
    assert.notInclude(text, "Private report");
    assert.notInclude(text, "Sao_Paulo");
    assert.notInclude(text, workspace);
    assert.notInclude(text, webhook.webhookUrl ?? "no address");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to share a bot whose file would be too large, naming its largest part", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const routines = yield* Routines;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.adjust("1 second");
    const bot = yield* bots.create({ commandId: command(), draft: { name: "Lena" } });
    // Within every limit, which count characters, but three bytes a character.
    const skills = path.join(layout.workspace(bot.id), "skills");
    const names = [...Array.from({ length: 15 }, (_, index) => `s${index + 10}`), "zeta"];
    for (const name of names) {
      yield* fs.makeDirectory(path.join(skills, name), { recursive: true });
      const text = "€".repeat(name === "zeta" ? 20_000 : 19_000);
      yield* fs.writeFileString(path.join(skills, name, "SKILL.md"), text);
    }
    for (const index of [1, 2, 3, 4, 5, 6]) {
      yield* routines.create({
        commandId: command(),
        botId: bot.id,
        draft: {
          name: `Watch ${index}`,
          instruction: "€".repeat(10_000),
          trigger: { _tag: "webhook" },
        },
        author: { _tag: "operator" },
      });
    }

    const refused = yield* (yield* Templates).template(bot.id).pipe(Effect.flip);

    assert.deepStrictEqual(
      refused._tag === "TemplateTooLarge"
        ? { largest: refused.largest, over: refused.size > MAX_TEMPLATE_FILE_SIZE }
        : refused,
      { largest: { _tag: "skill", name: "zeta" }, over: true },
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates the bot with its skills in its workspace and every routine paused", () =>
  Effect.gen(function* () {
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { timeZone } = yield* (yield* SettingsStore).get;

    const bot = yield* createFrom({ template: template() });

    assert.isFalse(bot.primary);
    assert.strictEqual(bot.profile.job, "Finds sources and summarizes them.");
    assert.deepStrictEqual(bot.profile.avatar, { shape: "bean", color: "honey" });
    const skill = path.join(layout.workspace(bot.id), "skills", "triage", "SKILL.md");
    assert.strictEqual(yield* fs.readFileString(skill), TRIAGE);
    const made = yield* (yield* Routines).list(bot.id);
    // Created in one instant, they list in no particular order.
    assert.sameDeepMembers(
      made.map((routine) => [routine.name, routine.enabled, routine.nextRunAt, routine.trigger]),
      [
        ["Morning digest", false, null, { _tag: "schedule", cron: "0 9 * * 1-5", timeZone }],
        ["Deploys", false, null, { _tag: "webhook" }],
      ],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts no more permissive than the default unless the operator picks the mode", () =>
  Effect.gen(function* () {
    // The test engine's providers default to Auto.
    const asked = yield* createFrom({ template: template({ permissionMode: "full-access" }) });
    const careful = yield* createFrom({ template: template({ permissionMode: "supervised" }) });
    const unknown = yield* createFrom({
      template: yield* Schema.decodeEffect(BotTemplateSchema)({
        ...template(),
        permissionMode: "a-mode-from-later",
      }),
    });
    const picked = yield* createFrom({
      template: template({ permissionMode: "supervised" }),
      permissionMode: "full-access",
    });

    assert.strictEqual(asked.permissionMode, "auto");
    assert.strictEqual(careful.permissionMode, "supervised");
    assert.strictEqual(unknown.permissionMode, "supervised");
    assert.strictEqual(picked.permissionMode, "full-access");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes the template's model only where the engine offers it", () =>
  Effect.gen(function* () {
    const elsewhere = { providerId: ProviderId.make("gemini"), modelId: ModelId.make("pro") };

    const offered = yield* createFrom({
      template: template({ model: TestDomain.OTHER_PROVIDER_MODEL }),
    });
    const fallback = yield* createFrom({ template: template({ model: elsewhere }) });
    const unknownLook = yield* createFrom({
      template: template({
        profile: { ...template().profile, avatar: { shape: "comet", color: "ultraviolet" } },
      }),
    });

    assert.deepStrictEqual(offered.model, TestDomain.OTHER_PROVIDER_MODEL);
    assert.deepStrictEqual(fallback.model, TestDomain.DEFAULT_MODEL);
    assert.notDeepEqual(unknownLook.profile.avatar, { shape: "comet", color: "ultraviolet" });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates nothing when a routine's schedule is refused", () =>
  Effect.gen(function* () {
    const store = yield* BotStore;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bots = path.dirname(layout.workspace(BotId.make("any")));
    yield* fs.makeDirectory(bots, { recursive: true });
    const before = yield* fs.readDirectory(bots);
    const known = (yield* store.list).length;

    const refused = yield* createFrom({
      template: template({
        routines: [
          {
            name: "Broken",
            instruction: "Never runs.",
            trigger: { _tag: "schedule", cron: "every morning" },
          },
        ],
      }),
    }).pipe(Effect.flip);

    assert.deepStrictEqual(
      [refused._tag, "reason" in refused ? refused.reason : null],
      ["Invalid", "schedule"],
    );
    assert.strictEqual((yield* store.list).length, known);
    assert.deepStrictEqual(yield* fs.readDirectory(bots), before);
  }).pipe(Effect.provide(TestDomain.layer)),
);
