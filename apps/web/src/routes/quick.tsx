// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute, notFound } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { desktop } from "../live/desktop";
import { QuickAccessLive } from "../quick/QuickAccessLive";

/** `solid`: the window is not see-through, so the card fills it (the app says which). */
const Search = Schema.Struct({ solid: Schema.optionalKey(Schema.Boolean) });

/**
 * Quick access to the primary bot: the page of the desktop app's small
 * window, which its global shortcut opens. A browser has no such window, and
 * answers this path with "not found".
 */
export const Route = createFileRoute("/quick")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  beforeLoad: () => {
    if (desktop === null) throw notFound();
  },
  component: QuickRoute,
});

function QuickRoute() {
  const { solid } = Route.useSearch();
  return desktop === null ? null : <QuickAccessLive app={desktop} solid={solid === true} />;
}
