// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, PairBotIds, pairBotIds } from "@j3-bots/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

const decodeBot = Schema.decodeUnknownSync(BotId);
const decodePair = Schema.decodeUnknownSync(PairBotIds);

/** Where a teammate conversation opens: at the message of one of its bots' cards. */
const Search = Schema.Struct({ at: Schema.optionalKey(EntryId) });

/**
 * The conversation between two bots, read-only. Addressed by the two bots,
 * sorted, whichever order the address names them in. The shell in the layout
 * renders it.
 */
export const Route = createFileRoute("/_app/pairs/$a/$b")({
  params: {
    parse: (raw) => {
      const [a, b] = decodePair(pairBotIds(decodeBot(raw.a), decodeBot(raw.b)));
      return { a, b };
    },
    stringify: ({ a, b }) => ({ a, b }),
  },
  validateSearch: Schema.toStandardSchemaV1(Search),
});
