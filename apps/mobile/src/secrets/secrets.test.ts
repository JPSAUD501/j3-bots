// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  EntryOrder,
  Secret,
  type SecretAskEntry,
  secretRequestFieldId,
  SiteOrigin,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { askAccess, askDraft, askedValues, secretChanges } from "./drafts.ts";
import { SHOWN_FOR, shownValues } from "./shown.ts";

const origin = Schema.decodeSync(SiteOrigin)("https://example.com");
const botId = Schema.decodeSync(BotId)("bot_0123456789abcdef");

const secretOf = (kind: unknown) =>
  Schema.decodeUnknownSync(Secret)({
    id: "sec_0123456789abcdef",
    name: "example-login",
    kind,
    access: { _tag: "every-bot" },
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    lastUse: null,
    lastReveal: null,
  });

const login = secretOf({ _tag: "login", origins: [origin], hasTotp: true });
const value = secretOf({ _tag: "value" });

const untouched = {
  name: "example-login",
  sites: origin,
  username: "",
  password: "",
  totp: "",
  removeTotp: false,
  value: "",
};

describe("a bot's ask", () => {
  const typed = { username: "alice", password: "hunter2", totp: "  ", value: "tok_example" };

  it("saves a login for the site the bot named", () => {
    const draft = Option.getOrThrow(askDraft({ _tag: "login", origin }, typed));
    if (draft._tag !== "login") throw new Error("expected a login");
    expect(draft.origins).toEqual([origin]);
    expect(Redacted.value(draft.username)).toBe("alice");
    expect(Redacted.value(draft.password)).toBe("hunter2");
    expect(draft.totp).toBeNull();
  });

  it("saves the value for a value", () => {
    const draft = Option.getOrThrow(askDraft({ _tag: "value" }, typed));
    if (draft._tag !== "value") throw new Error("expected a value");
    expect(Redacted.value(draft.value)).toBe("tok_example");
  });

  it("saves nothing without a password or a value", () => {
    expect(Option.isNone(askDraft({ _tag: "login", origin }, { ...typed, password: "" }))).toBe(
      true,
    );
    expect(Option.isNone(askDraft({ _tag: "value" }, { ...typed, value: "" }))).toBe(true);
  });

  it("lets only the asking bot use it, unless every bot may", () => {
    expect(askAccess(false, botId)).toEqual({ _tag: "bots", botIds: [botId] });
    expect(askAccess(true, botId)).toEqual({ _tag: "every-bot" });
  });
});

describe("a bot's ask for several values", () => {
  const asked = [
    { id: secretRequestFieldId(0), name: "builds-client-id", label: "Client ID", masked: false },
    {
      id: secretRequestFieldId(1),
      name: "builds-client-secret",
      label: "Client secret",
      masked: true,
    },
  ];
  const entry: SecretAskEntry = {
    _tag: "secret-ask",
    id: EntryId.make("ask"),
    order: EntryOrder.make(1),
    author: { _tag: "bot", botId },
    createdAt: DateTime.makeUnsafe(0),
    name: "builds-client-id",
    secret: { _tag: "value" },
    values: asked,
    note: "",
    status: { _tag: "pending" },
  };
  const access = askAccess(false, botId);

  it("saves each under the name the bot asked for it by, without the space around a paste", () => {
    const typed = new Map([
      [secretRequestFieldId(0), " client-7 "],
      [secretRequestFieldId(1), "a client secret"],
    ]);
    const saved = Option.getOrThrow(askedValues(entry, asked, typed, access));
    expect(saved.values.map(({ name, value }) => [name, Redacted.value(value)])).toEqual([
      ["builds-client-id", "client-7"],
      ["builds-client-secret", "a client secret"],
    ]);
  });

  it("saves nothing while one is left out", () => {
    const typed = new Map([[secretRequestFieldId(0), "client-7"]]);
    expect(Option.isNone(askedValues(entry, asked, typed, access))).toBe(true);
  });
});

describe("changing a secret", () => {
  it("keeps every value left empty", () => {
    expect(Option.getOrThrow(secretChanges(login, untouched))).toEqual({});
    expect(Option.getOrThrow(secretChanges(value, { ...untouched, sites: "" }))).toEqual({});
  });

  it("sends what was typed, and removes the one-time code key when asked", () => {
    const changes = Option.getOrThrow(
      secretChanges(login, {
        ...untouched,
        name: "renamed",
        sites: `${origin}\nhttps://accounts.example.com`,
        password: "new-password",
        removeTotp: true,
      }),
    );
    expect(changes.name).toBe("renamed");
    expect(changes.origins).toEqual([origin, "https://accounts.example.com"]);
    expect(changes.password === undefined ? null : Redacted.value(changes.password)).toBe(
      "new-password",
    );
    expect(changes.totp).toBeNull();
    expect(changes.username).toBeUndefined();
  });

  it("refuses a name or sites a secret does not take", () => {
    expect(Option.isNone(secretChanges(login, { ...untouched, name: "Has Spaces" }))).toBe(true);
    expect(Option.isNone(secretChanges(login, { ...untouched, sites: "ftp://example.com" }))).toBe(
      true,
    );
  });
});

describe("values shown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hides each value 30 seconds after it was shown", () => {
    let shown: ReadonlyMap<string, Redacted.Redacted<string>> = new Map();
    const values = shownValues<string>((now) => {
      shown = now;
    });
    values.show("username", Redacted.make("alice"));
    vi.advanceTimersByTime(SHOWN_FOR / 2);
    values.show("password", Redacted.make("hunter2"));
    vi.advanceTimersByTime(SHOWN_FOR / 2);
    expect([...shown.keys()]).toEqual(["password"]);
    vi.advanceTimersByTime(SHOWN_FOR / 2);
    expect(shown.size).toBe(0);
  });

  it("starts the time again when a value is shown again, and hides all at once", () => {
    let shown: ReadonlyMap<string, Redacted.Redacted<string>> = new Map();
    const values = shownValues<string>((now) => {
      shown = now;
    });
    values.show("password", Redacted.make("hunter2"));
    vi.advanceTimersByTime(SHOWN_FOR - 1);
    values.show("password", Redacted.make("hunter2"));
    vi.advanceTimersByTime(SHOWN_FOR - 1);
    expect(shown.has("password")).toBe(true);
    values.hideAll();
    expect(shown.size).toBe(0);
  });
});
