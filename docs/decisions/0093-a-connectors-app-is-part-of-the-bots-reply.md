# 0093: A connector's app is part of the bot's reply, in every display mode, and tells its bot what it shows

**Status:** Accepted. Amends [0048](0048-a-servers-interface-runs-isolated-in-j3-bots-clients.md): an app is drawn in the bot's reply rather than under the turn's work, inline, full screen or pinned, and what it sets as context reaches its bot. 0048's frame, its isolation and its rules for the app's calls hold as they were.

## Context

Under 0048 a connector's app was drawn under the work fold of the turn whose call opened it, inline only. It refused `ui/update-model-context`, so what the operator did in it never reached the bot. The owner asked for the app to be part of the bot's reply, where the bot called it, able to go full screen or to stay in sight while the conversation scrolls, and for the bot to know what the operator sees in it.

The MCP Apps extension, at its stable 2026-01-26 version, defines the three display modes a host may offer (`inline`, `fullscreen`, `pip`). An app asks for one with `ui/request-display-mode`, and the host answers with the mode it actually shows. The host tells the app its mode, the modes it offers and the room it has (`displayMode`, `availableDisplayModes`, `containerDimensions`), and says when any of them changes (`ui/notifications/host-context-changed`). The extension also defines `ui/update-model-context`: context for the model's next turn, which replaces what the app set before. Its draft adds `ui/download-file` and an app's own `ui/notifications/request-teardown` (**Read** in the extension's specification, `specification/2026-01-26` and `specification/draft`, at `87bcdc8c`).

## Decision

**An app is an entry of the bot's reply where its call happened, which every client shows inline, full screen over the conversation or pinned at its top, in the same frame, never loaded again for it. What it sets as context reaches its bot's next turn where it is shown, as its connector's data, and wakes nobody.**

- **An entry of the reply.** The server keeps the app as a `connector-app` entry of the conversation or room the turn speaks to, as the call returns, so it stands between what the bot said before the call and what it says after. The call keeps its step in the work fold, which no longer lists apps. A turn shows at most 20 apps. A routine's turn, which speaks to no one, shows none. After a tool's answer whose app was shown, the bot reads J3 Bots' line saying so, and that it need not repeat what the app shows.
- **Three modes, on every client.** The web, desktop and Android clients offer all three. The host answers `ui/request-display-mode` with the mode the app is shown in. That is the one it asked for, or the one it had when the client or the app does not offer it. The host keeps `displayMode`, `availableDisplayModes` and `containerDimensions` true, and sends `host-context-changed` with what changed each time one of them does.
  - **Full screen** covers the conversation between its header and its composer, which stays. The app's header has a control that puts it back in the reply, and so do Android's Back and Esc, pressed outside the app's frame (a key pressed in the app is the app's). What the bots say meanwhile shows over the app's lower part: the latest message, in a sheet the operator can hide.
  - **Pinned** keeps the app at the top of the conversation while it scrolls.
  - One app is shown other than inline at a time: another that takes the stage sends the first back to the reply. The app's place in the reply keeps its height and says where it is.
  - The frame is never loaded again. The web keeps the `<iframe>` in one place in the page and moves only its box. Android keeps each app's WebView in a registry, keyed by the app, and moves it between the views that show it.
- **Its context reaches its bot.** `ui/update-model-context` is offered only against a server that takes it (`ConnectorAppView.modelContext`).
  - It takes text and structured content, up to 8 KiB together.
  - The latest an app sets replaces what it set before, and an empty one takes it back.
  - The server keeps one per app, for the bot's next turn where the app is shown: the bot's conversation, or the room.
  - The bot reads it there, framed as that connector's untrusted content, as a tool's answer is. It wakes nobody, and is shown nowhere as a message.
  - It is refused once the bot no longer has the connector.
- **What it offers to save.** `ui/download-file` offers files, at most 8 and 16 MiB together, or addresses.
  - A file is saved only when the operator presses Save, under a name made safe: the browser's download, or Android's share sheet.
  - An address is shown as itself, which is where it goes, and opens in the browser, as a link does.
- **A complete host context.** `hostContext` carries every field 2026-01-26 defines:
  - the tool, the theme and its style variables;
  - the display, the language and the time zone;
  - the platform and the device's touch and hover;
  - the safe area, which is always none, since the frame sits inside the screen's;
  - a user agent that names J3 Bots and its protocol.
- **What a frame's lifetime is.** An app runs only near the conversation's view. Farther away, it is told it goes (`ui/resource-teardown`), and its frame goes once it answered, or after a second. It comes back at the height it had. An app shown full screen or pinned stays alive wherever its place in the reply is.
- **`ui/notifications/tool-input-partial` is never sent.** J3 Bots opens an app only once the call has returned, so its arguments are whole by then.
- **Still not granted.** Device permissions, nested frames and an origin of the app's own, as 0048 decided. That includes `clipboardWrite`, which the extension lets a host grant: Chromium grants `clipboard-write` to a frame its policy allows without asking, so an app could write to the operator's clipboard without a gesture. The desktop app also grants no permission to any frame ([Security: connector apps](../architecture/security.md#connector-apps)).
- **Protocol 11 holds.** A client that predates the entry shows it as one it does not know. A client of 0.14.0 still draws the apps an older fold lists, just after the fold's line. Against an older server, it refuses `ui/update-model-context` as before ([Clients: protocol compatibility](../architecture/clients.md#protocol-compatibility)).

## What it costs

- **An older client no longer draws a new app.** A client before 0.14.0 shows a new app's entry as one that needs a newer version of the app, where it drew apps under the fold before. Old folds' apps still show for it.
- **An app writes into the bot's input.** What it sets is its server's words, as a tool's answer is, and it reaches the bot without the bot calling anything. It is framed as that connector's data, bounded to 8 KiB, and kept only while the bot has the connector. A bot can still be misled by it as by any answer.
- **Full screen on Android is not a screen of its own.** It covers the conversation's list under its header, and Back closes it, so the conversation keeps one composer and the app keeps its frame.
- **A pinned app's place in the reply keeps the app's height**, so the reply does not jump as it pins and comes back.
- **An app kept running is memory.** A full-screen or pinned app, and on Android an app scrolled out of view for up to 20 seconds, keeps its frame.

## What was rejected

- **Keeping the app under the work fold.** It hid what the bot showed the operator behind its work, and away from what the bot said about it.
- **Loading the frame again in each mode.** The app would lose what the operator did in it each time it moved.
- **Full screen on Android as a screen the navigation pushes.** It would need a second composer for the conversation, and the frame would leave the conversation's registry.
- **An app's context as a message, or as a wake.** It would put a server's words in the operator's place, or start turns the operator did not ask for.
- **Granting `clipboardWrite`.** See above.
