// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

// Avatars became characters: twelve silhouettes and twelve colors in place
// of ten flat shapes and ten colors. Each bot takes the silhouette nearest
// its shape and the color nearest its own, so it stays recognizable. This
// file is frozen: it holds its own copy of both sets of names, so it does the
// same if they change later.

const SHAPES: Readonly<Record<string, string>> = {
  circle: "bean",
  square: "block",
  hexagon: "hex",
  diamond: "gem",
  triangle: "drop",
  clover: "ears",
  burst: "ghost",
  arch: "dome",
  plus: "horns",
  leaf: "pear",
};

const COLORS: Readonly<Record<string, string>> = {
  red: "tomato",
  orange: "tangerine",
  yellow: "honey",
  green: "mint",
  teal: "teal",
  blue: "sky",
  indigo: "cobalt",
  violet: "iris",
  pink: "rose",
  gray: "slate",
};

const Avatars = Schema.Struct({ key: Schema.String, shape: Schema.String, color: Schema.String });

/**
 * An old shape and color as the new ones nearest them. Migration 13 left no
 * other; anything else falls back as a client draws a token it does not know.
 */
const mapped = (old: { readonly shape: string; readonly color: string }) => ({
  shape: SHAPES[old.shape] ?? "dome",
  color: COLORS[old.color] ?? "slate",
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Avatars,
    execute: () => sql`SELECT id AS key, avatar_shape AS shape, avatar_color AS color FROM bots`,
  })(undefined).pipe(Effect.orDie);
  for (const bot of bots) {
    const { shape, color } = mapped(bot);
    yield* sql`UPDATE bots SET avatar_shape = ${shape}, avatar_color = ${color} WHERE id = ${bot.key}`;
  }
  // A command retried after the upgrade answers with the avatar it gave then,
  // in the names the clients draw now.
  const receipts = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Avatars,
    execute: () => sql`
      SELECT command_id AS key,
        json_extract(result_json, '$.profile.avatar.shape') AS shape,
        json_extract(result_json, '$.profile.avatar.color') AS color
      FROM command_receipts
      WHERE method IN ('bot.create', 'bot.update')
        AND json_type(result_json, '$.profile.avatar.shape') = 'text'
        AND json_type(result_json, '$.profile.avatar.color') = 'text'
    `,
  })(undefined).pipe(Effect.orDie);
  for (const receipt of receipts) {
    const { shape, color } = mapped(receipt);
    yield* sql`
      UPDATE command_receipts
      SET result_json = json_set(
        result_json, '$.profile.avatar', json_object('shape', ${shape}, 'color', ${color})
      )
      WHERE command_id = ${receipt.key}
    `;
  }
});
