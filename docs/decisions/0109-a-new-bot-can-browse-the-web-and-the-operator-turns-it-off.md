# 0109: A new bot can browse the web, and the operator turns it off

**Status:** Accepted. Amended by [0110](0110-j3-bots-runs-its-own-browsers-and-the-engines-is-off.md): from 0.16 the switch gives a bot J3 Bots' own browser, and the engine's is off. Replaces the browser being off for every bot until the operator turned it on, which came with 0.4.0 (migration `0025_bot_browser`, [Engine: the bot's browser](../architecture/engine.md#the-bots-browser)) without a record of its own.

## Context

Since 0.4.0 a bot could use the engine's browser only after the operator found its switch in the bot's details and turned it on. The switch was off for every bot so that nothing a bot did on a website happened before the operator chose it.

The owner wants the opposite default: a bot can use its browser from the start. Most jobs people give a bot touch the web, and a teammate that answers "I can't open that page" until someone finds a switch looks broken. The switch's words also said the wrong thing: "Use this computer's browser" read as the browser of the device the operator holds, while it is a browser of its own that the engine runs on the server's machine.

What was open:

- which bots get it: new ones, and whether bots made before could be given it too;
- what still guards a bot that browses when nobody chose it for that bot;
- what it costs a server with many bots.

## Decision

**Every new bot may use its browser: the operator's, one from a template, and one another bot makes. The operator turns it off per bot in its details. Bots made before keep their switch as it was.**

- **New bots.** `Bots` saves each new bot with its browser on; nothing in a creation request can ask otherwise. A helper made behind the scenes ([decision 0101](0101-a-bot-is-its-name-and-its-title-and-a-helper-waits-behind-the-scenes.md)) gets it too: it does the work its maker hands it, and that work often is on the web.
- **Bots made before stay as they are.** The server keeps only whether the switch is on. A bot with it off may be one the operator turned off, or one nobody ever touched, and nothing tells them apart; turning on a browser the operator took away would undo their choice. The release notes say how to turn it on.
- **The switch says what is true.** "Can browse the web", with one line under it: it uses the bots' shared browser, and calls the operator when a site asks them to sign in. While the bot has work running, one more line says that turning it off stops that work. A host that still needs setting up shows one short line with a link to the page that says how, not a command.

### What still guards it

- **Sign-ins are the operator's.** The bots' browser starts signed out of everything. A bot that meets a sign-in asks the operator with a help card ([Server: help in the browser](../architecture/server.md#help-in-the-browser)), and the operator signs in, or not, in the bot's tab.
- **A saved login is typed only where it allows.** The server fills one only for the bots it lists, while the bot's browser is on, on the login's own sites ([decision 0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md)). The bot never holds the value.
- **The operator can watch and take over** any tab, from any device, and the bot cannot act while they hold it.
- **One profile for every bot that browses.** A site the operator signs in to there is signed in for each of those bots. The operations guide says so where the switch is described, and Settings → Bots' browser signs out of every site at once.

### Cost

- **Instructions.** A bot with the browser gets its rules (`browser.md`, about 1.3 KB next to a base of about 17.7 KB), written once into its instruction file. The harness reads that file with the rest, so a turn costs a few hundred more input tokens, mostly cached.
- **The engine's settings.** The default changes no count. Each time a bot's session opens or takes new settings, and before each routine run, the adapter reads the engine's settings once and writes the project's browser access only when it differs (`withBrowserAccess`), one write at a time, for a bot off as for one on: one write in a project's life, and none at a server's start for bots whose sessions are already open.
- **The host check.** Each of those syncs with the browser on also asks for the check of what the host needs (`recheckBrowserHost`), which keeps the setup line in the bot's details current once someone has set the machine up. On Linux it runs up to three short processes (the downloaded browser's `--version`, `ldd`, `fc-match`); elsewhere none. Requests go through a queue of one, so many bots asking at once run it once, and one after another. With the default on, most bots now ask: a server with many bots and frequent routines runs it more often (its time was not measured). Checking only when a bot is first given the browser would leave that line stale after a fix, until the next restart.

## Consequences

- A new bot can open a page in its first turn.
- Turning the switch off still takes effect at once and stops what the bot is doing; turning it back on applies from its next turn. The switch says so only while there is work to stop; the operations guide has the rest.
- An operator who wants a bot off the web turns it off after creating it. A creation option to start it off was not added: it would ask a question at the moment the operator only wants a teammate.

## Rejected

- **Turning it on for every existing bot.** It would undo the switches operators turned off on purpose.
- **Asking at creation.** One more question when making a bot, for a choice most never change.
