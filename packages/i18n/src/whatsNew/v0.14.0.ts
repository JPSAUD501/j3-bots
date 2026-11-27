// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";

// What 0.14.0 lets people do. Written so far for what has merged; before the
// release, add the entry for MCP Apps shown in the bot's reply, with
// fullscreen and picture-in-picture. docs/operations/releasing.md says how an
// entry is written.

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
        en: "Reply to a message, or quote part of one",
        "pt-BR": "Responda a uma mensagem, ou cite um trecho dela",
      },
      body: {
        en: "Answer one message in particular, or point at the exact words you mean, and the bot knows what you’re talking about. In a room, replying to a bot’s message speaks to that bot.",
        "pt-BR":
          "Responda a uma mensagem específica, ou aponte as palavras exatas que você quer dizer, e o bot sabe do que você está falando. Numa sala, responder à mensagem de um bot fala com aquele bot.",
      },
      where: {
        en: "Reply is beside React on a message; on Android you can also swipe a message to the right. To quote, select words in a message and press Quote; on Android, use Quote part in the message’s menu.",
        "pt-BR":
          "Responder fica ao lado de Reagir numa mensagem; no Android você também pode deslizar a mensagem para a direita. Para citar, selecione palavras numa mensagem e toque em Citar; no Android, use Citar trecho no menu da mensagem.",
      },
    },
    {
      title: {
        en: "Dictate your message",
        "pt-BR": "Dite sua mensagem",
      },
      body: {
        en: "Talk instead of typing: your words appear in the message as you speak, and nothing is sent until you send it. Your voice becomes text on your own computer or phone, unless you choose an online service for it.",
        "pt-BR":
          "Fale em vez de digitar: suas palavras aparecem na mensagem enquanto você fala, e nada é enviado até você enviar. Sua voz vira texto no seu próprio computador ou celular, a não ser que você escolha um serviço online para isso.",
      },
      where: {
        en: "Tap the microphone beside the send button, and tap it again when you’re done. On a computer, Ctrl+Shift+Space does the same (⇧⌘Space on a Mac). Language, words to spell right and where your voice becomes text are in Settings → Voice.",
        "pt-BR":
          "Toque no microfone ao lado do botão de enviar e toque de novo quando terminar. No computador, Ctrl+Shift+Space faz o mesmo (⇧⌘Space no Mac). O idioma, as palavras para escrever certo e onde sua voz vira texto ficam em Configurações → Voz.",
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
