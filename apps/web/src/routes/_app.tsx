// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BrowserTabRef,
  type PairBotIds,
  RoutineId,
  type RosterItem,
  type RosterItemKey,
} from "@j3-bots/contracts";
import {
  Link,
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { lazy } from "react";
import { LiveSourceProvider } from "../live/LiveSource";
import { Shell } from "../shell/Shell";
import { useShellSource } from "../shell/source";

// Development serves a sample team, so every screen can be seen without a
// server, unless VITE_J3_SERVER names a server to run against. Both conditions
// are constant in a build, so a build always runs on its server and carries
// no sample.
const SourceProvider =
  import.meta.env.DEV && import.meta.env.VITE_J3_SERVER === undefined
    ? lazy(() =>
        import("../gallery/sampleSource").then((m) => ({ default: m.SampleSourceProvider })),
      )
    : LiveSourceProvider;

/**
 * What shows over the conversation: its details, and over a bot's details the
 * runs of one of its routines; or instead of the details the bot's browser, on
 * one tab or on the one the bot uses. In the address, so Back closes them and
 * they close when the conversation changes.
 */
const Search = Schema.Struct({
  details: Schema.optionalKey(Schema.Boolean),
  routine: Schema.optionalKey(RoutineId),
  // "front" first: a ref is any non-empty string, which would take "front" too.
  browser: Schema.optionalKey(Schema.Union([Schema.Literal("front"), BrowserTabRef])),
});

/** The app: one shell for every conversation, so the roster keeps its place between them. */
export const Route = createFileRoute("/_app")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: () => (
    <SourceProvider>
      <AppLayout />
    </SourceProvider>
  ),
});

/** A roster row is a link to its conversation, so it can be opened in a new tab. */
const rowLink = (item: RosterItem) =>
  item._tag === "bot" ? (
    <Link to="/bots/$botId" params={{ botId: item.bot.id }} />
  ) : (
    <Link to="/rooms/$roomId" params={{ roomId: item.room.id }} />
  );

/** A pair's row too: a link to the conversation between the two. */
const pairLink = ([a, b]: PairBotIds) => <Link to="/pairs/$a/$b" params={{ a, b }} />;

function AppLayout() {
  const { data, intents, browser: browserSource } = useShellSource();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { details, browser } = Route.useSearch();
  // Where a teammate conversation opens, which only its own route reads.
  const { at } = useSearch({ strict: false });
  const selected: RosterItemKey | null = params.botId
    ? { _tag: "bot", botId: params.botId }
    : params.roomId
      ? { _tag: "room", roomId: params.roomId }
      : null;
  const pair =
    params.a !== undefined && params.b !== undefined
      ? { botIds: [params.a, params.b] as const, at: at ?? null }
      : null;
  return (
    <>
      <Shell
        data={data}
        intents={{
          ...intents,
          openConversation: (botId) => navigate({ to: "/bots/$botId", params: { botId } }),
          openBrowser: (botId, tab) =>
            navigate({ to: "/bots/$botId", params: { botId }, search: { browser: tab } }),
        }}
        browser={browserSource}
        navigation={{
          selected,
          detailsOpen: details === true && selected !== null,
          select: (key) =>
            key === null
              ? navigate({ to: "/" })
              : key._tag === "bot"
                ? navigate({ to: "/bots/$botId", params: { botId: key.botId } })
                : navigate({ to: "/rooms/$roomId", params: { roomId: key.roomId } }),
          // The details and the browser take the same place: opening one closes the other.
          setDetailsOpen: (open) =>
            navigate({
              to: ".",
              search: (prev) =>
                open
                  ? {
                      details: true,
                      ...(prev.routine === undefined ? {} : { routine: prev.routine }),
                    }
                  : {},
            }),
          browser: browser ?? null,
          setBrowser: (target) =>
            navigate({ to: ".", search: target === null ? {} : { browser: target } }),
          rowLink,
          pair,
          openPair: ([a, b], entryId) =>
            navigate({
              to: "/pairs/$a/$b",
              params: { a, b },
              search: entryId === null ? {} : { at: entryId },
            }),
          pairLink,
        }}
      />
      <Outlet />
    </>
  );
}
