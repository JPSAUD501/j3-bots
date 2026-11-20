// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoomId } from "@j3-bots/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(RoomId);

/** A room. The shell in the layout renders it. */
export const Route = createFileRoute("/_app/rooms/$roomId")({
  params: {
    parse: (raw) => ({ roomId: decode(raw.roomId) }),
    stringify: ({ roomId }) => ({ roomId }),
  },
});
