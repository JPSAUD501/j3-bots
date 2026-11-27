// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, ThemeId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { BotStore } from "../bots/BotStore.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot, engineSession } from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Themes } from "./Themes.ts";

const dusk = { id: "dusk", name: "Dusk", canvas: "#1a1426", accent: "#e0a030" };

/** A bot's call to a theme tool, as its harness makes it. */
const callAs = (botId: BotId, tool: "theme_read" | "theme_save", args: Schema.Json, n = 1) =>
  Effect.gen(function* () {
    const sessionId = yield* engineSession(botId);
    return yield* (yield* BotTools).call({
      requestId: `${tool}-${botId}-${n}`,
      sessionId,
      tool,
      arguments: args,
    });
  });

const refusal = (reply: { readonly _tag: string; readonly message?: string }) =>
  reply._tag === "refused" ? (reply.message ?? "") : "";

/** The smallest PNG there is: a one-pixel image. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

const putInWorkspace = (botId: BotId, name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = Option.getOrThrow(yield* (yield* BotStore).find(botId)).workspacePath;
    yield* fs.makeDirectory(path.join(workspace, "files"), { recursive: true });
    yield* fs.writeFile(path.join(workspace, "files", name), bytes);
  });

it.effect("saves a bot's theme, tells it what moved, and lists it as that bot's", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const reply = yield* callAs(ana.id, "theme_save", dusk);
    assert.strictEqual(reply._tag, "result");
    const value = reply._tag === "result" ? reply.value : null;
    assert.deepInclude(value, { status: "saved", id: "dusk" });
    // Its amber accent darkens to read on the light canvas.
    const { adjustments } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ adjustments: Schema.Array(Schema.Struct({ role: Schema.String })) }),
    )(value);
    assert.isTrue(adjustments.some((a) => a.role === "accent"));

    const library = yield* (yield* Themes).library;
    assert.deepStrictEqual(
      library.themes.map((t) => ({ id: String(t.id), madeBy: t.madeBy })),
      [{ id: "dusk", madeBy: { _tag: "bot", botId: ana.id } }],
    );
    const read = yield* callAs(ana.id, "theme_read", { theme: "dusk" });
    assert.deepInclude(read._tag === "result" ? read.value : null, {
      saved: [{ id: "dusk", name: "Dusk", madeBy: "you", hasBackground: false }],
      defaultTheme: "palco",
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

for (const [why, args, reason] of [
  [
    "names a role a theme does not set",
    { ...dusk, colors: { waiting: "#ff0000" } },
    "not a theme role",
  ],
  ["gives a role no color", { ...dusk, colors: { border: "red" } }, "#rrggbb or oklch"],
  [
    "has CSS that loads a file",
    { ...dusk, css: 'body { background: url("https://example.test/p.png"); }' },
    "cannot load",
  ],
  ["takes a built-in's id", { ...dusk, id: "oceano" }, "built-in"],
] as const) {
  it.effect(`refuses a theme that ${why}, saving nothing`, () =>
    Effect.gen(function* () {
      const ana = yield* createBot("Ana");
      const reply = yield* callAs(ana.id, "theme_save", args);
      assert.include(refusal(reply), reason);
      assert.deepStrictEqual((yield* (yield* Themes).library).themes, []);
    }).pipe(Effect.provide(TestDomain.layer)),
  );
}

it.effect("leaves the operator's themes and another bot's to them", () =>
  Effect.gen(function* () {
    const themes = yield* Themes;
    yield* themes.save({
      commandId: CommandId.make("cmd-mine"),
      definition: { name: "Mine", canvas: "#101820", accent: "#3fd0e0" },
    });
    const ana = yield* createBot("Ana");
    const bia = yield* createBot("Bia");
    assert.include(
      refusal(yield* callAs(ana.id, "theme_save", { ...dusk, id: "mine" })),
      "your user made",
    );
    yield* callAs(ana.id, "theme_save", dusk);
    assert.include(
      refusal(yield* callAs(bia.id, "theme_save", { ...dusk, name: "Not Dusk" })),
      "another bot's",
    );
    // Ana changes her own.
    const again = yield* callAs(ana.id, "theme_save", { ...dusk, name: "Dusk 2" }, 2);
    assert.strictEqual(again._tag, "result");
    const saved = (yield* themes.library).themes.map((t) => t.definition.name);
    assert.sameMembers([...saved], ["Mine", "Dusk 2"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a theme's image from the bot's workspace, served by its revision", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    yield* putInWorkspace(ana.id, "dusk.png", PNG);
    yield* putInWorkspace(ana.id, "notes.png", new TextEncoder().encode("<svg></svg>"));
    assert.include(
      refusal(yield* callAs(ana.id, "theme_save", { ...dusk, background: "files/notes.png" })),
      "not a JPEG, PNG or WebP",
    );
    assert.include(
      refusal(yield* callAs(ana.id, "theme_save", { ...dusk, background: "../../x.png" }, 2)),
      "background image",
    );

    yield* callAs(ana.id, "theme_save", { ...dusk, background: "files/dusk.png" }, 3);
    const themes = yield* Themes;
    const [saved] = (yield* themes.library).themes;
    const background = saved?.background ?? null;
    assert.strictEqual(background?.mediaType, "image/png");
    const served = yield* themes.background(ThemeId.make("dusk"), background?.revision ?? "");
    assert.deepStrictEqual(
      Option.map(served, (image) => [...image.bytes]),
      Option.some([...PNG]),
    );

    // Saved again without `background`, it keeps the image; with null, it drops it.
    yield* callAs(ana.id, "theme_save", { ...dusk, name: "Dusk again" }, 4);
    assert.deepStrictEqual((yield* themes.library).themes[0]?.background, background);
    yield* callAs(ana.id, "theme_save", { ...dusk, background: null }, 5);
    assert.isNull((yield* themes.library).themes[0]?.background ?? null);
    assert.isTrue(
      Option.isNone(yield* themes.background(ThemeId.make("dusk"), background?.revision ?? "")),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("names a new theme from its name, and resets the default when it is deleted", () =>
  Effect.gen(function* () {
    const themes = yield* Themes;
    const definition = { name: "Céu de Março", canvas: "#0d1720", accent: "#8fb4ff" };
    const first = yield* themes.save({ commandId: CommandId.make("cmd-1"), definition });
    const second = yield* themes.save({ commandId: CommandId.make("cmd-2"), definition });
    assert.deepStrictEqual([first.id, second.id], ["ceu-de-marco", "ceu-de-marco-2"]);

    yield* themes.setDefault({ commandId: CommandId.make("cmd-3"), themeId: first.id });
    assert.strictEqual((yield* themes.library).defaultTheme, "ceu-de-marco");
    yield* themes.remove({ commandId: CommandId.make("cmd-4"), themeId: first.id });
    assert.strictEqual((yield* themes.library).defaultTheme, "palco");

    const missing = yield* themes
      .setDefault({ commandId: CommandId.make("cmd-5"), themeId: first.id })
      .pipe(Effect.flip);
    assert.deepInclude(missing, { _tag: "NotFound", resource: "theme" });
  }).pipe(Effect.provide(TestDomain.layer)),
);
