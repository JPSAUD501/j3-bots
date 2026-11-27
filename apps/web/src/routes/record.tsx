// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute, notFound } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { desktop } from "../live/desktop";
import { RecorderLive } from "../record/RecorderLive";

/** `solid`: the window is not see-through, so the control fills it (the app says which). */
const Search = Schema.Struct({ solid: Schema.optionalKey(Schema.Boolean) });

/**
 * The floating control of a screen recording (decision 0098): the page of the
 * desktop app's small window that records while the operator shows their
 * screen. A browser has no such window, and answers this path with "not found".
 */
export const Route = createFileRoute("/record")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  beforeLoad: () => {
    if (desktop === null) throw notFound();
  },
  component: RecordRoute,
});

function RecordRoute() {
  const { solid } = Route.useSearch();
  return desktop === null ? null : <RecorderLive app={desktop} solid={solid === true} />;
}
