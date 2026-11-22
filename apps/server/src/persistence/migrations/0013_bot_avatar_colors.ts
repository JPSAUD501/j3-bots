// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";
import { resolveAvatar } from "@j3-bots/design-tokens";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { freeAvatar } from "../../bots/avatars.ts";

const BotAvatar = Schema.Struct({ id: Schema.String, shape: Schema.String, color: Schema.String });

/** Whether the clients draw `avatar` in its own color, rather than in the gray they fall back to. */
const drawn = (avatar: Avatar) => resolveAvatar(avatar).color === avatar.color;

// Earlier releases gave new bots colors from a list of their own, some of
// which the clients' palette does not have, so those bots showed gray. Each
// such bot keeps its shape and takes the color a new bot of that shape would,
// in the order the bots were created.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: BotAvatar,
    execute: () => sql`
      SELECT id, avatar_shape AS shape, avatar_color AS color FROM bots ORDER BY created_at, id
    `,
  })(undefined).pipe(Effect.orDie);
  const taken: Array<Avatar> = bots.filter(drawn);
  for (const bot of bots) {
    if (drawn(bot)) continue;
    const avatar = freeAvatar(taken, [bot.shape]);
    yield* sql`UPDATE bots SET avatar_color = ${avatar.color} WHERE id = ${bot.id}`;
    taken.push(avatar);
  }
});
