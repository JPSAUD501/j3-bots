// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  ConnectorNotice,
  EntryId,
  LANGUAGES,
  NotificationKind,
  RoomId,
  type Language,
  type Notification,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createI18n } from "./i18n.ts";
import { notificationText, type NotificationNames } from "./notification.ts";

const scout = BotId.make("scout");
const launch = RoomId.make("launch");
const names: NotificationNames = {
  botName: (id) => (id === scout ? "Scout" : null),
  roomName: (id) => (id === launch ? "Launch" : null),
};

const notification = (extra: Partial<Notification>): Notification => ({
  target: { _tag: "conversation", botId: scout },
  entryId: EntryId.make("e1"),
  botId: scout,
  kind: "message",
  preview: null,
  connector: null,
  ...extra,
});

type Said = Record<Language, { readonly bare: string; readonly preview: string }>;

/**
 * What each kind says in each language, without a preview and with "Ship it?";
 * a connector card's, for each card.
 */
const wording: Record<Exclude<NotificationKind, "connector">, Said> & {
  readonly connector: Record<ConnectorNotice, Said>;
} = {
  message: {
    en: { bare: "Sent you a message", preview: "Ship it?" },
    "pt-BR": { bare: "Enviou uma mensagem", preview: "Ship it?" },
  },
  question: {
    en: { bare: "Has a question for you", preview: "Asks: Ship it?" },
    "pt-BR": { bare: "Tem uma pergunta para você", preview: "Pergunta: Ship it?" },
  },
  approval: {
    en: { bare: "Needs your approval", preview: "Needs approval: Ship it?" },
    "pt-BR": { bare: "Precisa da sua aprovação", preview: "Precisa de aprovação: Ship it?" },
  },
  "secret-request": {
    en: { bare: "Needs a credential", preview: "Needs a credential: Ship it?" },
    "pt-BR": { bare: "Precisa de uma credencial", preview: "Precisa de uma credencial: Ship it?" },
  },
  "browser-help": {
    en: {
      bare: "Needs your help in the browser",
      preview: "Needs your help in the browser: Ship it?",
    },
    "pt-BR": {
      bare: "Precisa da sua ajuda no navegador",
      preview: "Precisa da sua ajuda no navegador: Ship it?",
    },
  },
  connector: {
    "sign-in": {
      en: {
        bare: "A service needs you to sign in again",
        preview: "Ship it? needs you to sign in again",
      },
      "pt-BR": {
        bare: "Um serviço precisa que você entre de novo",
        preview: "Ship it? precisa que você entre de novo",
      },
    },
  },
  handoff: {
    en: { bare: "Sent a teammate an urgent message", preview: "To a teammate: Ship it?" },
    "pt-BR": {
      bare: "Mandou uma mensagem urgente a um colega",
      preview: "Para um colega: Ship it?",
    },
  },
};

const cases = NotificationKind.literals.flatMap((kind) =>
  (kind === "connector"
    ? ConnectorNotice.literals.map((card) => ({
        kind,
        connector: card,
        said: wording.connector[card],
      }))
    : [{ kind, connector: null, said: wording[kind] }]
  ).flatMap((made) =>
    LANGUAGES.map((language) => ({ ...made, language, said: made.said[language] })),
  ),
);

describe("notificationText", () => {
  it.each(cases)("words a $kind $connector in $language", ({ kind, connector, language, said }) => {
    const i18n = createI18n(language);
    const of = (preview: string | null) =>
      notificationText(notification({ kind, connector, preview }), names, i18n);
    expect(of(null)).toEqual({ title: "Scout", body: said.bare });
    expect(of("Ship it?")).toEqual({ title: "Scout", body: said.preview });
  });

  it("comes from the room, naming the bot, for what was said in one", () => {
    const inRoom = notification({ target: { _tag: "room", roomId: launch }, preview: "Done" });
    expect(notificationText(inRoom, names, createI18n("en"))).toEqual({
      title: "Launch",
      body: "Scout: Done",
    });
    const bare = notification({ target: { _tag: "room", roomId: launch }, kind: "approval" });
    expect(notificationText(bare, names, createI18n("pt-BR"))).toEqual({
      title: "Launch",
      body: "Scout: Precisa da sua aprovação",
    });
  });

  it("says nothing for a bot or a room that no longer has a name", () => {
    const i18n = createI18n("en");
    const gone = notification({ botId: BotId.make("gone") });
    expect(notificationText(gone, names, i18n)).toBeNull();
    const elsewhere = notification({ target: { _tag: "room", roomId: RoomId.make("old") } });
    expect(notificationText(elsewhere, names, i18n)).toBeNull();
  });
});
