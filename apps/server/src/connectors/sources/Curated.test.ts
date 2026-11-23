// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { FieldKey } from "@j3-bots/contracts";
import * as Result from "effect/Result";
import shipped from "./curated.json" with { type: "json" };
import {
  CURATED,
  curatedDetails,
  curatedEntry,
  curatedMatches,
  decodeCuratedList,
} from "./Curated.ts";

/** The shipped list with `change` made to a copy of it. */
const changed = (change: (list: typeof shipped) => void) => {
  const copy = structuredClone(shipped);
  change(copy);
  return copy;
};

const refused = (list: unknown) => Result.isFailure(decodeCuratedList(list));

const entry = (key: string) => {
  const found = curatedEntry(CURATED, key);
  if (found === undefined) throw new Error(`no ${key} in the list`);
  return found;
};

describe("the curated list", () => {
  it("ships the one-tap, token and own-app services the gallery features", () => {
    const kinds = Object.fromEntries(CURATED.connectors.map((one) => [one.id, one.connect.kind]));
    for (const key of ["notion", "linear", "atlassian", "stripe", "figma", "vercel", "supabase"]) {
      assert.strictEqual(kinds[key], "sign-in", key);
    }
    assert.strictEqual(kinds.github, "token");
    assert.strictEqual(kinds["linear-key"], "token");
    assert.strictEqual(kinds.slack, "own-app");
    assert.strictEqual(kinds["google-gmail"], "own-app");
  });

  it("refuses an entry without text in every language, or at an address that is not https", () => {
    assert.isFalse(refused(shipped));
    assert.isTrue(
      refused(
        changed((list) => {
          const [first] = list.connectors;
          if (first !== undefined) first.summary["pt-BR"] = "";
        }),
      ),
    );
    assert.isTrue(
      refused(
        changed((list) => {
          const [first] = list.connectors;
          if (first !== undefined) first.remote.url = "http://mcp.example.com/mcp";
        }),
      ),
    );
    assert.isTrue(
      refused(
        changed((list) => {
          list.apps.google.setupUrl = "https://user@console.example.com/";
        }),
      ),
    );
  });

  it("refuses a glyph J3 Bots does not draw, a key listed twice, or an app no one uses", () => {
    assert.isTrue(
      refused(
        changed((list) => {
          const [first] = list.connectors;
          if (first !== undefined) first.glyph = "vendor-logo";
        }),
      ),
    );
    assert.isTrue(
      refused(
        changed((list) => {
          const [first] = list.connectors;
          if (first !== undefined) list.connectors.push(structuredClone(first));
        }),
      ),
    );
    assert.isTrue(
      refused(
        changed((list) => {
          list.connectors = list.connectors.filter((one) => one.id !== "slack");
        }),
      ),
    );
  });

  it("refuses an app whose parameters would replace the sign-in's own", () => {
    for (const parameter of ["redirect_uri", "state", "code_challenge", "resource", "scope"]) {
      assert.isTrue(
        refused(
          changed((list) => {
            list.apps.google.authorizationParameters = {
              ...list.apps.google.authorizationParameters,
              [parameter]: "https://elsewhere.example",
            };
          }),
        ),
        parameter,
      );
    }
  });

  it("guides an own-app setup with the connector's scopes, and says Google's servers are a preview", () => {
    const slack = curatedDetails(CURATED, entry("slack"), "en");
    assert.strictEqual(slack.connect, "own-app");
    const listed = slack.setup?.steps.find((step) => step.includes("user token scopes"));
    assert.include(listed, "search:read.public, search:read.private");
    assert.notInclude(listed, "{scopes}");

    const gmail = curatedDetails(CURATED, entry("google-gmail"), "pt-BR");
    assert.include(gmail.description, "prévia para desenvolvedores");
    assert.include(gmail.setup?.url ?? "", "https://console.cloud.google.com/");
    // The form fills in the server the app is registered at.
    assert.strictEqual(gmail.setup?.issuer, "https://accounts.google.com");
    assert.deepStrictEqual(gmail.fields, []);
  });

  it("asks a token entry for its token in one masked field, under its own label", () => {
    const github = curatedDetails(CURATED, entry("github"), "pt-BR");
    assert.deepStrictEqual(github.fields, [
      {
        key: FieldKey.make("header:Authorization:token"),
        label: "Token de acesso pessoal refinado",
        description: null,
        secret: true,
        required: true,
        placeholder: null,
        choices: [],
      },
    ]);
    assert.strictEqual(github.setup?.url, "https://github.com/settings/personal-access-tokens/new");
  });

  it("finds an entry by what it does, in either language, without accents", () => {
    const found = (query: string) =>
      CURATED.connectors
        .filter((one) => curatedMatches(CURATED, one, query))
        .map((one): string => one.id);
    assert.include(found("email"), "google-gmail");
    assert.include(found("agenda"), "google-calendar");
    assert.include(found("codigo"), "github");
    assert.deepStrictEqual(found("   "), []);
  });
});
