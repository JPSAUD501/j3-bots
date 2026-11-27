// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";

// What 0.14.0 lets people do. docs/operations/releasing.md says how an entry
// is written.

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
        en: "Talk instead of typing: what you say becomes your message, and nothing is sent until you send it. In the browser and the desktop app your voice becomes text on your J3 Bots server, and on Android on the phone itself when it can; it goes to an online service only if you choose one.",
        "pt-BR":
          "Fale em vez de digitar: o que você diz vira a sua mensagem, e nada é enviado até você enviar. No navegador e no app para computador, sua voz vira texto no seu servidor do J3 Bots, e no Android, no próprio celular quando ele consegue; ela só vai para um serviço online se você escolher um.",
      },
      where: {
        en: "Tap the microphone beside the send button, and tap it again when you’re done. On a computer, Ctrl+Shift+Space does the same (⇧⌘Space on a Mac). Language, words to spell right and where your voice becomes text are in Settings → Voice.",
        "pt-BR":
          "Toque no microfone ao lado do botão de enviar e toque de novo quando terminar. No computador, Ctrl+Shift+Space faz o mesmo (⇧⌘Space no Mac). O idioma, as palavras para escrever certo e onde sua voz vira texto ficam em Configurações → Voz.",
      },
    },
    {
      title: {
        en: "Use a service’s app right in the bot’s reply",
        "pt-BR": "Use o app de um serviço direto na resposta do bot",
      },
      body: {
        en: "When a service a bot uses draws something for you, like a list or a map, it shows in the bot’s reply, where the bot used it. Open it full screen to work in it, and some apps stay pinned at the top while you keep chatting.",
        "pt-BR":
          "Quando um serviço que o bot usa desenha algo para você, como uma lista ou um mapa, isso aparece na resposta do bot, onde ele usou o serviço. Abra em tela cheia para mexer nele, e alguns apps ficam fixados no topo enquanto você continua conversando.",
      },
      where: {
        en: "Show full screen is at the top of the app. Close it, or press Put it back here, to return it to the reply.",
        "pt-BR":
          "Mostrar em tela cheia fica no topo do app. Feche, ou toque em Trazer de volta para cá, para devolvê-lo à resposta.",
      },
    },
    {
      title: {
        en: "Show a bot what you mean by recording your screen",
        "pt-BR": "Mostre a um bot o que você quer dizer gravando a tela",
      },
      body: {
        en: "In the desktop app, record what you do on your computer, with your voice, and it goes to the bot as a file with your message. The bot looks at it and decides what to do with it.",
        "pt-BR":
          "No app para computador, grave o que você faz no computador, com a sua voz, e a gravação vai para o bot como um arquivo junto com a sua mensagem. O bot olha e decide o que fazer com ela.",
      },
      where: {
        en: "Click + beside the message field and choose Record your screen; a bot can also offer it under one of its messages. Before it starts, it tells you exactly what is recorded, and Pause hides anything you don’t want in it.",
        "pt-BR":
          "Clique em + ao lado do campo da mensagem e escolha Gravar a tela; um bot também pode oferecer isso embaixo de uma mensagem dele. Antes de começar, ele diz exatamente o que é gravado, e Pausar esconde o que você não quiser na gravação.",
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
        en: "J3 Bots now shares anonymous usage data",
        "pt-BR": "O J3 Bots agora compartilha dados de uso anônimos",
      },
      body: {
        en: "It tells the people who make J3 Bots which features get used and what goes wrong, and it’s on unless you turn it off. It never includes what you or your bots write, names, files or addresses.",
        "pt-BR":
          "Eles contam a quem faz o J3 Bots quais recursos são usados e o que dá errado, e ficam ligados a não ser que você desligue. Nunca incluem o que você ou seus bots escrevem, nomes, arquivos ou endereços.",
      },
      where: {
        en: "Settings → About and updates → Privacy. Turn off Share anonymous usage data there, or open See what is sent to see exactly what left.",
        "pt-BR":
          "Configurações → Sobre e atualizações → Privacidade. Desligue Compartilhar dados de uso anônimos ali, ou abra Ver o que é enviado para ver exatamente o que saiu.",
      },
    },
    {
      title: {
        en: "Get a file that helps someone fix a problem",
        "pt-BR": "Baixe um arquivo que ajuda alguém a resolver um problema",
      },
      body: {
        en: "When something behaves oddly, download a diagnostics file and send it to whoever helps you. It says how J3 Bots is running, and never holds your messages, names or passwords.",
        "pt-BR":
          "Quando algo se comportar de um jeito estranho, baixe um arquivo de diagnóstico e envie para quem te ajuda. Ele diz como o J3 Bots está funcionando, e nunca traz suas mensagens, nomes ou senhas.",
      },
      where: {
        en: "Settings → About and updates → Privacy → Download diagnostics.",
        "pt-BR": "Configurações → Sobre e atualizações → Privacidade → Baixar diagnóstico.",
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
