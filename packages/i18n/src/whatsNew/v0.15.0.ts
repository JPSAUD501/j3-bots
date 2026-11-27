// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";

// What 0.15.0 lets people do. docs/operations/releasing.md says how an entry
// is written.

export const v0_15_0: WhatsNewRelease = {
  version: "0.15.0",
  entries: [
    {
      title: {
        en: "See a bot’s card",
        "pt-BR": "Veja o cartão de um bot",
      },
      body: {
        en: "A bot’s card says who it is, what it’s doing, what it’s for and who created it. From it you can talk to the bot, start a room with it, or send it a quick message without leaving where you are.",
        "pt-BR":
          "O cartão de um bot diz quem ele é, o que está fazendo, para que serve e quem o criou. Dele você pode falar com o bot, começar uma sala com ele ou mandar uma mensagem rápida sem sair de onde está.",
      },
      where: {
        en: "Rest the pointer on a bot’s face or name. On Android, press and hold its face.",
        "pt-BR": "Pare o ponteiro sobre o rosto ou o nome de um bot. No Android, toque e segure no rosto dele.",
      },
    },
    {
      title: {
        en: "Each bot’s title, under its name",
        "pt-BR": "O cargo de cada bot, embaixo do nome",
      },
      body: {
        en: "Wherever a bot is named, its title says what it’s there for, as a job title does under a colleague’s name. A new bot needs one. Bots you keep out of your list are now Behind the scenes.",
        "pt-BR":
          "Onde quer que um bot apareça, o cargo diz para que ele está ali, como o cargo embaixo do nome de um colega. Um bot novo precisa de um. Os bots que você deixa fora da lista agora ficam Nos bastidores.",
      },
      where: {
        en: "For a bot with no title, open its menu and choose Give a title.",
        "pt-BR": "Para um bot sem cargo, abra o menu dele e escolha Dar um cargo.",
      },
    },
    {
      title: {
        en: "Let your bots talk among themselves",
        "pt-BR": "Deixe seus bots conversarem entre si",
      },
      body: {
        en: "When you ask a bot to get others working together, it can open a room of bots only. You read everything there but don’t write in it, and after a few rounds it pauses and the bot tells you where things got to.",
        "pt-BR":
          "Quando você pede a um bot para juntar outros num trabalho, ele pode abrir uma sala só de bots. Você lê tudo lá, mas não escreve, e depois de algumas rodadas ela pausa e o bot te conta onde as coisas chegaram.",
      },
    },
    {
      title: {
        en: "More AI accounts, and one place to pick a bot’s AI",
        "pt-BR": "Mais contas de IA, e um só lugar para escolher a IA de um bot",
      },
      body: {
        en: "Add more than one Claude Code or Codex account, and turn each on or off. When you make or edit a bot, one picker chooses its account, its model, how hard it thinks and, for some models, Fast.",
        "pt-BR":
          "Adicione mais de uma conta do Claude Code ou do Codex, e ligue ou desligue cada uma. Quando você cria ou edita um bot, um só seletor escolhe a conta, o modelo, o quanto ele pensa e, em alguns modelos, Rápida.",
      },
      where: {
        en: "Settings → Providers → Add account. Star the models you use most to find them first.",
        "pt-BR":
          "Configurações → Provedores → Adicionar conta. Marque com estrela os modelos que você mais usa para achá-los primeiro.",
      },
    },
    {
      title: {
        en: "Pick a theme, or make your own",
        "pt-BR": "Escolha um tema, ou crie o seu",
      },
      body: {
        en: "Seven themes change how J3 Bots looks, each in light and dark, and two colors are enough to make a new one. A bot can make a theme for you too; it shows up only when you press Apply theme.",
        "pt-BR":
          "Sete temas mudam a cara do J3 Bots, cada um no claro e no escuro, e duas cores bastam para criar um novo. Um bot também pode criar um tema para você; ele só aparece quando você toca em Aplicar tema.",
      },
      where: {
        en: "Settings → Appearance → Theme. Each device keeps its own.",
        "pt-BR": "Configurações → Aparência → Tema. Cada aparelho guarda o seu.",
      },
    },
    {
      title: {
        en: "Dictate with the service you choose",
        "pt-BR": "Dite com o serviço que você escolher",
      },
      body: {
        en: "In the browser and the desktop app, your voice goes to OpenAI, xAI or OpenRouter with your own key, and you can keep typing while you talk. A screen recording now carries what you said too. On Android, the phone itself still writes it down when it can.",
        "pt-BR":
          "No navegador e no app para computador, sua voz vai para a OpenAI, a xAI ou o OpenRouter com a sua própria chave, e você pode continuar digitando enquanto fala. Uma gravação da tela agora leva também o que você disse. No Android, o próprio celular ainda escreve quando consegue.",
      },
      where: {
        en: "Settings → Voice: choose the service and paste its key. Until then, the microphone opens that page.",
        "pt-BR":
          "Configurações → Voz: escolha o serviço e cole a chave. Até lá, o microfone abre essa página.",
      },
    },
    {
      title: {
        en: "New bots can browse the web",
        "pt-BR": "Bots novos podem navegar na internet",
      },
      body: {
        en: "Every new bot starts with the browser on. Bots you made before keep their setting as it was.",
        "pt-BR":
          "Todo bot novo já começa com o navegador ligado. Os bots que você criou antes continuam como estavam.",
      },
      where: {
        en: "To let an older bot browse, turn on Can browse the web in its details.",
        "pt-BR": "Para deixar um bot mais antigo navegar, ligue Pode navegar na internet nos detalhes dele.",
      },
    },
    {
      title: {
        en: "Comment on the part you quote",
        "pt-BR": "Comente o trecho que você cita",
      },
      body: {
        en: "A reply or a quote now sits inside the message field, and a quoted passage can carry a comment the bot reads with it. Nothing sits under the field any more.",
        "pt-BR":
          "Uma resposta ou uma citação agora fica dentro do campo da mensagem, e um trecho citado pode levar um comentário que o bot lê junto. Nada mais fica embaixo do campo.",
      },
      where: {
        en: "Select words in a message and press Quote; on Android, use Quote part in the message’s menu.",
        "pt-BR":
          "Selecione palavras numa mensagem e toque em Citar; no Android, use Citar trecho no menu da mensagem.",
      },
    },
  ],
};
