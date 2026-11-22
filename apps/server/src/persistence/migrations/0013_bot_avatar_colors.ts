// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

// Earlier releases gave new bots colors from a list of their own, some of
// which the clients' palette does not have, and took any shape or color the
// operator or a bot named, so those bots showed gray. Each such bot keeps the
// part of its avatar the clients draw and takes the rest as the server picked
// it when this was written. This file is frozen: it holds its own copy of the
// tokens and of the pick, so it does the same if they change later.

const SHAPES = [
  "circle",
  "square",
  "hexagon",
  "diamond",
  "triangle",
  "clover",
  "burst",
  "arch",
  "plus",
  "leaf",
] as const;
const HUES = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
const DRAWN_SHAPES: ReadonlySet<string> = new Set(SHAPES);
const DRAWN_COLORS: ReadonlySet<string> = new Set([...HUES, "gray"]);

interface Avatar {
  readonly shape: string;
  readonly color: string;
}

const BotAvatar = Schema.Struct({ id: Schema.String, shape: Schema.String, color: Schema.String });

function* cycle<T>(items: readonly [T, ...T[]]): Generator<T, never> {
  for (;;) yield* items;
}

/**
 * `avatar` with what the clients do not draw replaced: the first of the least
 * used among `taken`, walking the shapes and the hues in step, with the part
 * the clients draw held.
 */
const repaired = (avatar: Avatar, taken: ReadonlyArray<Avatar>): Avatar => {
  const keepShape = DRAWN_SHAPES.has(avatar.shape);
  const keepColor = DRAWN_COLORS.has(avatar.color);
  const uses = new Map<string, number>();
  for (const { shape, color } of taken) {
    const key = `${shape}/${color}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const usesOf = ({ shape, color }: Avatar) => uses.get(`${shape}/${color}`) ?? 0;
  const shapes = cycle(SHAPES);
  const hues = cycle(HUES);
  const next = (): Avatar => {
    const shape = shapes.next().value;
    const color = hues.next().value;
    return { shape: keepShape ? avatar.shape : shape, color: keepColor ? avatar.color : color };
  };
  let best = next();
  for (let pair = 1; pair < SHAPES.length * HUES.length; pair++) {
    const candidate = next();
    if (usesOf(candidate) < usesOf(best)) best = candidate;
  }
  return best;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: BotAvatar,
    execute: () => sql`
      SELECT id, avatar_shape AS shape, avatar_color AS color FROM bots ORDER BY created_at, id
    `,
  })(undefined).pipe(Effect.orDie);
  const drawn = ({ shape, color }: Avatar) => DRAWN_SHAPES.has(shape) && DRAWN_COLORS.has(color);
  const taken: Array<Avatar> = bots.filter(drawn);
  for (const bot of bots) {
    if (drawn(bot)) continue;
    const avatar = repaired(bot, taken);
    yield* sql`
      UPDATE bots SET avatar_shape = ${avatar.shape}, avatar_color = ${avatar.color}
      WHERE id = ${bot.id}
    `;
    // A command retried after the upgrade answers with the avatar the bot has now.
    yield* sql`
      UPDATE command_receipts
      SET result_json = json_set(
        result_json, '$.profile.avatar', json_object('shape', ${avatar.shape}, 'color', ${avatar.color})
      )
      WHERE method IN ('bot.create', 'bot.update')
        AND json_extract(result_json, '$.id') = ${bot.id}
        AND json_extract(result_json, '$.profile.avatar.shape') = ${bot.shape}
        AND json_extract(result_json, '$.profile.avatar.color') = ${bot.color}
    `;
    taken.push(avatar);
  }
});
