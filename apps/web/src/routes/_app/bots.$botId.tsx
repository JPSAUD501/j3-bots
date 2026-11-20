// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(BotId);

/** A bot's conversation. The shell in the layout renders it. */
export const Route = createFileRoute("/_app/bots/$botId")({
  params: {
    parse: (raw) => ({ botId: decode(raw.botId) }),
    stringify: ({ botId }) => ({ botId }),
  },
});
