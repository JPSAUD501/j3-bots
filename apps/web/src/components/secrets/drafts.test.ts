// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  EntryOrder,
  type SecretAskEntry,
  type SecretDraft,
  secretRequestFieldId,
  SiteOrigin,
} from "@j3-bots/contracts";
import { at } from "@j3-bots/client-runtime/testing";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { askedSecret, askedValues, editChanges, newSecret, type TypedSecret } from "./drafts";

const scout = BotId.make("scout");
const ask = (secret: SecretAskEntry["secret"]): SecretAskEntry => ({
  _tag: "secret-ask",
  id: EntryId.make("ask"),
  order: EntryOrder.make(1),
  author: { _tag: "bot", botId: scout },
  createdAt: at("2026-11-20T10:00:00Z"),
  name: "billing-dashboard",
  secret,
  note: "",
  status: { _tag: "pending" },
});
const loginAsk = ask({ _tag: "login", origin: SiteOrigin.make("https://billing.example.com") });
const valueAsk = ask({ _tag: "value" });
const typedLogin = { username: "finance", password: "an example password", totp: "", value: "" };

/** The draft's values in the clear, to compare. */
const opened = (draft: SecretDraft) =>
  draft._tag === "value"
    ? { _tag: "value", value: Redacted.value(draft.value) }
    : {
        _tag: "login",
        origins: draft.origins,
        username: Redacted.value(draft.username),
        password: Redacted.value(draft.password),
        totp: draft.totp === null ? null : Redacted.value(draft.totp),
      };

describe("the secret a bot's ask saves", () => {
  it("is a login for the site the bot named, under its name, for that bot only", () => {
    const saved = askedSecret(loginAsk, typedLogin, false);
    if (saved._tag !== "ready") throw new Error("expected a secret");
    expect(saved.value.name).toBe("billing-dashboard");
    expect(saved.value.access).toEqual({ _tag: "bots", botIds: [scout] });
    expect(opened(saved.value.draft)).toEqual({
      _tag: "login",
      origins: ["https://billing.example.com"],
      username: "finance",
      password: "an example password",
      totp: null,
    });
  });

  it("is for every bot when the operator lets every bot use it", () => {
    const saved = askedSecret(loginAsk, typedLogin, true);
    expect(saved._tag === "ready" && saved.value.access).toEqual({ _tag: "every-bot" });
  });

  it("keeps a one-time code key typed, without the space around it", () => {
    const saved = askedSecret(loginAsk, { ...typedLogin, totp: " GEZDGNBVGY3TQOJQ " }, false);
    expect(saved._tag === "ready" && opened(saved.value.draft)).toMatchObject({
      totp: "GEZDGNBVGY3TQOJQ",
    });
  });

  it("is a single value, without the space a paste brings, for a value the bot asked for", () => {
    const saved = askedSecret(valueAsk, { ...typedLogin, value: "  wx_example_0123\n" }, false);
    expect(saved._tag === "ready" && opened(saved.value.draft)).toEqual({
      _tag: "value",
      value: "wx_example_0123",
    });
  });

  it("waits for a password, or a value, before it is saved", () => {
    expect(askedSecret(loginAsk, { ...typedLogin, password: "" }, false)).toEqual({
      _tag: "invalid",
      problem: "password",
    });
    expect(askedSecret(valueAsk, { ...typedLogin, value: "   " }, false)).toEqual({
      _tag: "invalid",
      problem: "value",
    });
  });

  it("is refused for a card from before secrets whose name no secret takes", () => {
    expect(askedSecret({ ...loginAsk, name: "Billing dashboard" }, typedLogin, false)).toEqual({
      _tag: "invalid",
      problem: "name",
    });
  });
});

const typed: TypedSecret = {
  name: "support-desk",
  sites: "https://support.example.com\nsupport.example.com/login",
  username: "",
  password: "",
  totp: "",
  removeTotp: false,
  value: "",
};

describe("a secret the operator adds", () => {
  it("is a login for each site typed, once each", () => {
    const added = newSecret(true, { ...typed, password: "pw" }, { _tag: "every-bot" });
    expect(added._tag === "ready" && opened(added.value.draft)).toMatchObject({
      origins: ["https://support.example.com"],
    });
  });

  it("says which field stops it", () => {
    const none = { _tag: "bots", botIds: [] } as const;
    expect(newSecret(true, { ...typed, name: "Support desk", password: "pw" }, none)).toEqual({
      _tag: "invalid",
      problem: "name",
    });
    expect(newSecret(true, { ...typed, sites: "ftp://example.com", password: "pw" }, none)).toEqual(
      { _tag: "invalid", problem: "sites" },
    );
    expect(newSecret(false, typed, none)).toEqual({ _tag: "invalid", problem: "value" });
  });
});

describe("an edit of a secret", () => {
  it("changes only the values typed, keeping the ones left empty", () => {
    const changes = editChanges(true, { ...typed, password: "new password" });
    if (changes._tag !== "ready") throw new Error("expected changes");
    expect(Object.keys(changes.value).toSorted()).toEqual(["name", "origins", "password"]);
  });

  it("removes a login's one-time code key when asked, whatever was typed for it", () => {
    const changes = editChanges(true, { ...typed, totp: "GEZDGNBVGY3TQOJQ", removeTotp: true });
    expect(changes._tag === "ready" && changes.value.totp).toBeNull();
  });

  it("of a single value never sends a login's fields", () => {
    const changes = editChanges(false, { ...typed, password: "ignored", value: "wx_new" });
    if (changes._tag !== "ready") throw new Error("expected changes");
    expect(Object.keys(changes.value).toSorted()).toEqual(["name", "value"]);
  });
});

describe("the values a bot's ask for several saves", () => {
  const asked = [
    { id: secretRequestFieldId(0), name: "builds-client-id", label: "Client ID", masked: false },
    {
      id: secretRequestFieldId(1),
      name: "builds-client-secret",
      label: "Client secret",
      masked: true,
    },
  ];
  const valuesAsk: SecretAskEntry = { ...valueAsk, name: "builds-client-id", values: asked };

  it("are each saved under the name the bot asked for it by, without the space around a paste", () => {
    const typed = new Map([
      [secretRequestFieldId(0), " client-7 "],
      [secretRequestFieldId(1), "a client secret\n"],
    ]);
    const saved = askedValues(valuesAsk, asked, typed, false);
    if (saved._tag !== "ready") throw new Error("expected values");
    expect(saved.value.access).toEqual({ _tag: "bots", botIds: [scout] });
    expect(
      saved.value.values.map(({ field, name, value }) => [field, name, Redacted.value(value)]),
    ).toEqual([
      [secretRequestFieldId(0), "builds-client-id", "client-7"],
      [secretRequestFieldId(1), "builds-client-secret", "a client secret"],
    ]);
  });

  it("are not ready while one is left out, which they name", () => {
    const typed = new Map([[secretRequestFieldId(0), "client-7"]]);
    expect(askedValues(valuesAsk, asked, typed, false)).toEqual({
      _tag: "invalid",
      problem: { _tag: "value", field: secretRequestFieldId(1) },
    });
  });
});
