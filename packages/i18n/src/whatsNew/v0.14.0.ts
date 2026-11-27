// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";

// What 0.14.0 lets people do. Written so far for what has merged; before the
// release, add an entry each for the work still under way: MCP Apps shown in
// the bot's reply, with fullscreen and picture-in-picture; replying to a
// message and quoting part of one; and dictating a message with the
// microphone. docs/operations/releasing.md says how an entry is written.

export const v0_14_0: WhatsNewRelease = {
  version: "0.14.0",
  entries: [
    {
      title: {
        en: "Mention other bots and rooms when you talk to a bot",
        "pt-BR": "Mencione outros bots e salas ao falar com um bot",
      },
      body: {
        en: "In a bot’s conversation, point at another bot or at a room it’s in. It understands what you mean: it asks the other bot and brings you the answer, passes your message on, posts in the room, or reads what happened there and sums it up.",
        "pt-BR":
          "Na conversa com um bot, aponte outro bot ou uma sala de que ele participa. Ele entende o que você quer: pergunta ao outro bot e te traz a resposta, repassa sua mensagem, posta na sala ou lê o que rolou lá e resume.",
      },
      where: {
        en: "Type @ in the message field. Tap a name in a message to open that bot or room.",
        "pt-BR":
          "Digite @ no campo da mensagem. Toque num nome numa mensagem para abrir aquele bot ou sala.",
      },
    },
    {
      title: {
        en: "See a bot’s little ones until they’re done",
        "pt-BR": "Veja os filhotes de um bot até eles terminarem",
      },
      body: {
        en: "When a bot splits into little ones to do parts of a job, they stay under its face after it answers you, each saying what it’s doing, and go back into it as they finish.",
        "pt-BR":
          "Quando um bot se divide em filhotes para fazer partes de um trabalho, eles continuam sob o rosto dele depois que ele te responde, cada um dizendo o que está fazendo, e voltam para ele conforme terminam.",
      },
    },
    {
      title: {
        en: "What’s new, after each update",
        "pt-BR": "Novidades, a cada atualização",
      },
      body: {
        en: "Each time J3 Bots updates, this page tells you what you can do now. A small mark points to it until you open it.",
        "pt-BR":
          "Cada vez que o J3 Bots atualiza, esta página conta o que você pode fazer agora. Uma pequena marca aponta para ela até você abrir.",
      },
    },
  ],
};
