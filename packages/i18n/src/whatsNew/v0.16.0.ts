// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";

// What 0.16.0 lets people do. docs/operations/releasing.md says how an entry
// is written.

export const v0_16_0: WhatsNewRelease = {
  version: "0.16.0",
  entries: [
    {
      title: {
        en: "Your bots browse on your computer",
        "pt-BR": "Seus bots navegam no seu computador",
      },
      body: {
        en: "While J3 Bots is open on your computer, your bots browse there, in a real browser on your own connection. When no computer is open, they browse on the server, and you can follow along from anywhere.",
        "pt-BR":
          "Com o J3 Bots aberto no seu computador, seus bots navegam nele, num navegador de verdade e com a sua própria conexão. Quando nenhum computador está aberto, eles navegam no servidor, e você acompanha de onde estiver.",
      },
    },
    {
      title: {
        en: "A browser of your own in the desktop app",
        "pt-BR": "Um navegador só seu no app para computador",
      },
      body: {
        en: "Browse beside the conversation or in a window of its own, with tabs, history, find, downloads and a way to reopen a closed tab. A private tab is never seen by your bots and forgets everything when you close it.",
        "pt-BR":
          "Navegue ao lado da conversa ou numa janela só para isso, com abas, histórico, busca na página, downloads e como reabrir uma aba fechada. Uma aba privada nunca é vista pelos seus bots e esquece tudo quando você fecha.",
      },
      where: {
        en: "Press the globe at the top of a conversation. Open in a window and New private tab are in the browser’s menu.",
        "pt-BR":
          "Toque no globo no alto de uma conversa. Abrir em janela e Nova aba privada ficam no menu do navegador.",
      },
    },
    {
      title: {
        en: "Sign in once, stay signed in everywhere",
        "pt-BR": "Entre uma vez e continue conectado em todo lugar",
      },
      body: {
        en: "The sites you and your bots sign in to are kept locked away and go with you between your computer and the server. Bots can fill in a saved login without ever seeing the password, and the sites they signed in to before are already here.",
        "pt-BR":
          "Os sites em que você e seus bots entram ficam guardados a sete chaves e vão junto entre o seu computador e o servidor. Os bots podem preencher um login salvo sem nunca ver a senha, e os sites em que eles já tinham entrado continuam aqui.",
      },
      where: {
        en: "Settings → Browser lists the sites that keep data, to clear one site’s data or every site’s.",
        "pt-BR":
          "Configurações → Navegador mostra os sites com dados guardados, para apagar os de um ou de todos.",
      },
    },
    {
      title: {
        en: "Take the page just by using it",
        "pt-BR": "Assuma a página só de usá-la",
      },
      body: {
        en: "Several bots can work on one tab, taking turns. When you click, type or scroll there, they wait for you and carry on 10 seconds after you stop. Wait for me holds the page for as long as you need.",
        "pt-BR":
          "Vários bots podem trabalhar na mesma aba, cada um na sua vez. Quando você clica, digita ou rola a página, eles esperam e voltam 10 segundos depois que você para. Esperar por mim segura a página pelo tempo que você precisar.",
      },
    },
    {
      title: {
        en: "See each bot at work on the page",
        "pt-BR": "Veja cada bot trabalhando na página",
      },
      body: {
        en: "Each bot has its own pointer, in its colour, with its face and name, and its face sits on the tabs it’s on. On the web and Android you watch the page live and take over with a touch; a closed tab comes back with Undo.",
        "pt-BR":
          "Cada bot tem o próprio ponteiro, na cor dele, com o rosto e o nome, e o rosto dele aparece nas abas em que está. Na web e no Android você vê a página ao vivo e assume com um toque; uma aba fechada volta com Desfazer.",
      },
      where: {
        en: "On a phone, press the page at the end of a bot’s conversation, or See the browser.",
        "pt-BR": "No celular, toque na página no fim da conversa de um bot, ou em Ver o navegador.",
      },
    },
  ],
};
