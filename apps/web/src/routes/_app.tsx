// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";
import { Link, Outlet, createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Shell } from "../shell/Shell";
import { useShellSource } from "../shell/source";

const Search = Schema.Struct({ details: Schema.optionalKey(Schema.Boolean) });

/** The app: one shell for every conversation, so the roster keeps its place between them. */
export const Route = createFileRoute("/_app")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: AppLayout,
});

/** A roster row is a link to its conversation, so it can be opened in a new tab. */
const rowLink = (item: RosterItem) =>
  item._tag === "bot" ? (
    <Link to="/bots/$botId" params={{ botId: item.bot.id }} />
  ) : (
    <Link to="/rooms/$roomId" params={{ roomId: item.room.id }} />
  );

function AppLayout() {
  const { data, intents } = useShellSource();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { details } = Route.useSearch();
  const selected: RosterItemKey | null = params.botId
    ? { _tag: "bot", botId: params.botId }
    : params.roomId
      ? { _tag: "room", roomId: params.roomId }
      : null;
  return (
    <>
      <Shell
        data={data}
        intents={{
          ...intents,
          openConversation: (botId) => navigate({ to: "/bots/$botId", params: { botId } }),
        }}
        navigation={{
          selected,
          detailsOpen: details === true && selected !== null,
          select: (key) =>
            key === null
              ? navigate({ to: "/" })
              : key._tag === "bot"
                ? navigate({ to: "/bots/$botId", params: { botId: key.botId } })
                : navigate({ to: "/rooms/$roomId", params: { roomId: key.roomId } }),
          setDetailsOpen: (open) =>
            navigate({ to: ".", search: (prev) => (open ? { ...prev, details: true } : {}) }),
          rowLink,
        }}
      />
      <Outlet />
    </>
  );
}
