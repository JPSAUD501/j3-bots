// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  type Conflict,
  Invalid,
  NotFound,
  SavedTheme,
  ThemeBackground,
  ThemeDefinition,
  ThemeId,
  ThemeLibrary,
  type ThemeMaker,
} from "@j3-bots/contracts";
import {
  DEFAULT_THEME_ID,
  isBuiltInThemeId,
  resolveTheme,
  type ThemeAdjustment,
} from "@j3-bots/design-tokens";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { json, Time, timeText } from "../persistence/columns.ts";

/** The most themes the server keeps that bots may add to: a bot saves none past it. */
export const MAX_SAVED_THEMES = 50;

/** An image to show behind the conversation, its type read from its bytes. */
export interface BackgroundImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ThemeBackground["mediaType"];
}

/** What a bot's save does to its theme's image: keeps it, removes it, or sets this one. */
export type BackgroundChange =
  | { readonly _tag: "keep" }
  | { readonly _tag: "remove" }
  | { readonly _tag: "set"; readonly image: BackgroundImage };

/** Why a bot's theme was not saved, in words the bot reads. */
export class ThemeRefused extends Schema.TaggedError<ThemeRefused>()("ThemeRefused", {
  reason: Schema.Literals(["definition", "operator-made", "not-yours", "limit"]),
  /** For `definition`: what `@j3-bots/design-tokens` refused, in its words. */
  detail: Schema.String,
}) {}

const Adjustment = Schema.Struct({
  appearance: Schema.Literals(["light", "dark"]),
  role: Schema.String,
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
});

/** A bot's save, as its receipt keeps it: the theme, and each color that had to move. */
const BotSave = Schema.Struct({ theme: SavedTheme, adjustments: Schema.Array(Adjustment) });
export type BotSave = typeof BotSave.Type;

const ThemeRow = Schema.Struct({
  id: ThemeId,
  definition: json(ThemeDefinition),
  made_by: Schema.Literals(["operator", "bot"]),
  made_by_bot: Schema.NullOr(BotId),
  updated_at: Time,
  revision: Schema.NullOr(Schema.String),
  media_type: Schema.NullOr(ThemeBackground.fields.mediaType),
});

const toSaved = (row: typeof ThemeRow.Type): SavedTheme => ({
  id: row.id,
  definition: row.definition,
  madeBy:
    row.made_by === "operator"
      ? { _tag: "operator" }
      : { _tag: "bot", botId: row.made_by_bot },
  background:
    row.revision === null || row.media_type === null
      ? null
      : { revision: row.revision, mediaType: row.media_type },
  updatedAt: row.updated_at,
});

const encodeDefinition = Schema.encodeSync(json(ThemeDefinition));

/**
 * A new theme's id from its name: lowercase letters and digits joined by
 * hyphens, accents dropped, `theme` for a name with none of them.
 */
const idStem = (name: string): string => {
  const stem = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return stem === "" ? "theme" : stem;
};

/**
 * The themes the operator and the bots saved, and the theme a device shows
 * until its person picks one (decision 0104). A theme is its definition;
 * every client derives its palettes with `@j3-bots/design-tokens`, as the
 * server checks them here, so a theme saved is one every client can show.
 * The seven built-ins live in the clients and are never stored.
 */
export class Themes extends Context.Service<
  Themes,
  {
    readonly library: Effect.Effect<ThemeLibrary>;
    /** The library now, then again after each change has committed, whoever made it. */
    readonly changes: Stream.Stream<ThemeLibrary>;
    /** A saved theme. */
    readonly find: (id: ThemeId) => Effect.Effect<Option.Option<SavedTheme>>;
    /** Whether a device can be offered `id`: a built-in's id or a saved theme's. */
    readonly exists: (id: ThemeId) => Effect.Effect<boolean>;
    /**
     * Saves a theme the operator made: new without `themeId`, named from its
     * name, or replacing the saved theme `themeId`, whose image stays.
     * `Invalid("theme")` for a definition the design tokens refuse,
     * `NotFound("theme")` for an id with no saved theme.
     */
    readonly save: (input: {
      readonly commandId: CommandId;
      readonly themeId?: ThemeId;
      readonly definition: ThemeDefinition;
    }) => Effect.Effect<SavedTheme, Invalid | NotFound | Conflict>;
    /** Deletes a saved theme and its image; a default that named it becomes the stock theme. */
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly themeId: ThemeId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /** The theme a device shows until its person picks one. `NotFound("theme")` for none. */
    readonly setDefault: (input: {
      readonly commandId: CommandId;
      readonly themeId: ThemeId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /**
     * Saves a theme a bot made, under `themeId`: a new one, or one a bot
     * made, which only that bot or the primary bot (`primary`) changes. A
     * theme the operator made is theirs to change.
     */
    readonly saveFromBot: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly primary: boolean;
      readonly themeId: ThemeId;
      readonly definition: ThemeDefinition;
      readonly background: BackgroundChange;
    }) => Effect.Effect<BotSave, ThemeRefused | Conflict>;
    /** A saved theme's image, while `revision` is its revision. */
    readonly background: (
      themeId: ThemeId,
      revision: string,
    ) => Effect.Effect<Option.Option<BackgroundImage>>;
  }
>()("@j3-bots/server/themes/Themes") {}

export const layer = Layer.effect(
  Themes,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* CommandReceipts;
    const digest = yield* Digest.Digest;

    const listRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ThemeRow,
      execute: () => sql`
        SELECT t.id, t.definition, t.made_by, t.made_by_bot, t.updated_at,
          b.revision, b.media_type
        FROM themes t LEFT JOIN theme_backgrounds b ON b.theme_id = t.id
        ORDER BY t.updated_at DESC, t.id
      `,
    });
    const findRow = SqlSchema.findOneOption({
      Request: ThemeId,
      Result: ThemeRow,
      execute: (id) => sql`
        SELECT t.id, t.definition, t.made_by, t.made_by_bot, t.updated_at,
          b.revision, b.media_type
        FROM themes t LEFT JOIN theme_backgrounds b ON b.theme_id = t.id
        WHERE t.id = ${id}
      `,
    });
    const defaultRow = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ default_theme: ThemeId }),
      execute: () => sql`SELECT default_theme FROM settings`,
    });
    const countRow = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Int }),
      execute: () => sql`SELECT COUNT(*) AS count FROM themes`,
    });
    const imageRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ themeId: ThemeId, revision: Schema.String }),
      Result: Schema.Struct({
        media_type: ThemeBackground.fields.mediaType,
        bytes: Schema.Uint8Array,
      }),
      execute: ({ themeId, revision }) => sql`
        SELECT media_type, bytes FROM theme_backgrounds
        WHERE theme_id = ${themeId} AND revision = ${revision}
      `,
    });

    const load = Effect.gen(function* () {
      const rows = yield* listRows(undefined);
      const { default_theme } = yield* defaultRow(undefined);
      return { themes: rows.map(toSaved), defaultTheme: default_theme } satisfies ThemeLibrary;
    }).pipe(Effect.orDie);

    const current = yield* SubscriptionRef.make(yield* load);
    /** Tells subscribers the library as committed now; serialized, so the last read wins. */
    const publish = SubscriptionRef.updateEffect(current, () => load);

    const find = (id: ThemeId) =>
      findRow(id).pipe(Effect.orDie, Effect.map(Option.map(toSaved)));

    const require = Effect.fn("Themes.require")(function* (id: ThemeId) {
      const found = yield* find(id);
      if (Option.isNone(found)) return yield* new NotFound({ resource: "theme" });
      return found.value;
    });

    const exists = (id: ThemeId) =>
      isBuiltInThemeId(id) ? Effect.succeed(true) : Effect.map(find(id), Option.isSome);

    /** An id for a new theme of the operator's: its name's stem, numbered past any taken. */
    const freshId = Effect.fn("Themes.freshId")(function* (name: string) {
      const stem = idStem(name);
      for (let n = 1; ; n++) {
        const id = ThemeId.make(n === 1 ? stem : `${stem}-${n}`);
        if (!isBuiltInThemeId(id) && !(yield* exists(id))) return id;
      }
    });

    const write = Effect.fn("Themes.write")(function* (input: {
      readonly id: ThemeId;
      readonly definition: ThemeDefinition;
      readonly madeBy: ThemeMaker;
    }) {
      const at = timeText(yield* DateTime.now);
      const botId = input.madeBy._tag === "bot" ? input.madeBy.botId : null;
      yield* sql`
        INSERT INTO themes (id, definition, made_by, made_by_bot, created_at, updated_at)
        VALUES (
          ${input.id}, ${encodeDefinition(input.definition)}, ${input.madeBy._tag}, ${botId},
          ${at}, ${at}
        )
        ON CONFLICT (id) DO UPDATE SET
          definition = excluded.definition,
          made_by = excluded.made_by,
          made_by_bot = excluded.made_by_bot,
          updated_at = excluded.updated_at
      `.pipe(Effect.orDie);
    });

    const save = Effect.fn("Themes.save")(function* (input: {
      readonly commandId: CommandId;
      readonly themeId?: ThemeId;
      readonly definition: ThemeDefinition;
    }) {
      const saved = yield* receipts.once({
        commandId: input.commandId,
        method: "theme.save",
        payload: input,
        result: SavedTheme,
        apply: Effect.gen(function* () {
          if (resolveTheme(input.definition)._tag === "refused") {
            return yield* new Invalid({ reason: "theme" });
          }
          if (input.themeId !== undefined) yield* require(input.themeId);
          const id = input.themeId ?? (yield* freshId(input.definition.name));
          yield* write({ id, definition: input.definition, madeBy: { _tag: "operator" } });
          return yield* require(id).pipe(Effect.orDie);
        }),
      });
      yield* publish;
      return saved;
    });

    const remove = Effect.fn("Themes.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly themeId: ThemeId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "theme.delete",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* require(input.themeId);
          // The image goes with it (`ON DELETE CASCADE`).
          yield* sql`DELETE FROM themes WHERE id = ${input.themeId}`.pipe(Effect.orDie);
          yield* sql`
            UPDATE settings SET default_theme = ${DEFAULT_THEME_ID}
            WHERE default_theme = ${input.themeId}
          `.pipe(Effect.orDie);
        }),
      });
      yield* publish;
    });

    const setDefault = Effect.fn("Themes.setDefault")(function* (input: {
      readonly commandId: CommandId;
      readonly themeId: ThemeId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "theme.setDefault",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          if (!(yield* exists(input.themeId))) return yield* new NotFound({ resource: "theme" });
          yield* sql`UPDATE settings SET default_theme = ${input.themeId}`.pipe(Effect.orDie);
        }),
      });
      yield* publish;
    });

    const saveFromBot = Effect.fn("Themes.saveFromBot")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly primary: boolean;
      readonly themeId: ThemeId;
      readonly definition: ThemeDefinition;
      readonly background: BackgroundChange;
    }) {
      const resolution = resolveTheme(input.definition);
      if (resolution._tag === "refused") {
        return yield* new ThemeRefused({ reason: "definition", detail: resolution.reason });
      }
      // The receipt is keyed on the image's digest, never on its bytes.
      const image =
        input.background._tag === "set"
          ? {
              ...input.background.image,
              revision: (yield* digest.digestHex(Digest.sha256, input.background.image.bytes)).slice(
                0,
                32,
              ),
            }
          : undefined;
      const saved = yield* receipts.once({
        commandId: input.commandId,
        method: "theme_save",
        payload: {
          botId: input.botId,
          themeId: input.themeId,
          definition: input.definition,
          background:
            image === undefined ? input.background._tag : { revision: image.revision },
        },
        result: BotSave,
        apply: Effect.gen(function* () {
          const found = yield* find(input.themeId);
          if (Option.isSome(found)) {
            const maker = found.value.madeBy;
            if (maker._tag === "operator") {
              return yield* new ThemeRefused({ reason: "operator-made", detail: "" });
            }
            if (!input.primary && maker.botId !== input.botId) {
              return yield* new ThemeRefused({ reason: "not-yours", detail: "" });
            }
          } else if ((yield* countRow(undefined).pipe(Effect.orDie)).count >= MAX_SAVED_THEMES) {
            return yield* new ThemeRefused({ reason: "limit", detail: "" });
          }
          // A changed theme stays the bot's that made it, whoever changed it.
          const madeBy: ThemeMaker = Option.isSome(found)
            ? found.value.madeBy
            : { _tag: "bot", botId: input.botId };
          yield* write({ id: input.themeId, definition: input.definition, madeBy });
          if (input.background._tag === "remove") {
            yield* sql`DELETE FROM theme_backgrounds WHERE theme_id = ${input.themeId}`.pipe(
              Effect.orDie,
            );
          }
          if (image !== undefined) {
            yield* sql`
              INSERT INTO theme_backgrounds (theme_id, revision, media_type, bytes)
              VALUES (${input.themeId}, ${image.revision}, ${image.mediaType}, ${image.bytes})
              ON CONFLICT (theme_id) DO UPDATE SET
                revision = excluded.revision,
                media_type = excluded.media_type,
                bytes = excluded.bytes
            `.pipe(Effect.orDie);
          }
          const theme = yield* require(input.themeId).pipe(Effect.orDie);
          const adjustments: ReadonlyArray<ThemeAdjustment> = resolution.adjustments;
          return { theme, adjustments: adjustments.map((a) => ({ ...a })) };
        }),
      });
      yield* publish;
      return saved;
    });

    const background = (themeId: ThemeId, revision: string) =>
      imageRow({ themeId, revision }).pipe(
        Effect.orDie,
        Effect.map(
          Option.map((row): BackgroundImage => ({ bytes: row.bytes, mediaType: row.media_type })),
        ),
      );

    return Themes.of({
      library: SubscriptionRef.get(current),
      changes: SubscriptionRef.changes(current),
      find,
      exists,
      save,
      remove,
      setDefault,
      saveFromBot,
      background,
    });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
