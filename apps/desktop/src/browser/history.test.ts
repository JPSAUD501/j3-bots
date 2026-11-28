// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { BrowserTabRef } from "@j3-bots/contracts";
import { suggestionsFor, type Visit, withVisit } from "./history.ts";

const visit = (url: string, at: number, title = ""): Visit => ({ url, title, at, byBot: false });

describe("the address bar's suggestions", () => {
  const tab = {
    ref: BrowserTabRef.make("t1"),
    url: "https://docevida.example/",
    title: "Doce Vida",
  };
  const visits = [
    visit("https://docesdavovo.example/", 3, "Doces da Vovó"),
    visit("https://docevida.example/", 2),
    visit("https://example.org/doce", 1),
  ];

  it("puts the open tab first, then what was visited, then the search", () => {
    const tags = suggestionsFor("doce", [tab], visits).map((suggestion) =>
      suggestion._tag === "search"
        ? `search:${suggestion.text}`
        : `${suggestion._tag}:${suggestion.url}`,
    );
    assert.deepStrictEqual(tags, [
      "tab:https://docevida.example/",
      "visited:https://docesdavovo.example/",
      "visited:https://example.org/doce",
      "search:doce",
    ]);
  });

  it("offers the sites visited most when nothing is typed", () => {
    const many = [
      visit("https://b.example/2", 5),
      visit("https://a.example/", 4),
      visit("https://b.example/1", 3),
    ];
    const sites = suggestionsFor(" ", [], many).map((suggestion) =>
      suggestion._tag === "visited" ? suggestion.url : suggestion._tag,
    );
    assert.deepStrictEqual(sites, ["https://b.example/2", "https://a.example/"]);
  });

  it("keeps one visit per address, the latest", () => {
    const kept = withVisit(
      withVisit([], visit("https://a.example/", 1)),
      visit("https://a.example/", 2),
    );
    assert.deepStrictEqual(
      kept.map((entry) => entry.at),
      [2],
    );
  });
});
