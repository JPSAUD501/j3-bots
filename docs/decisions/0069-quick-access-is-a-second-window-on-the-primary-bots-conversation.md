# 0069: Quick access is a second window on the primary bot's conversation

**Status:** Accepted.

## Context

The desktop app had a global shortcut that brought its window forward with the cursor in the composer. The owner asked for more of it: the shortcut should open a small transparent, draggable window in the bottom-right corner, with the primary bot's face, its recent conversation and the composer, for a quick request made from inside another app.

Four things were settled before the build: the existing shortcut opens and closes quick access, and only that (the tray still opens the main window); nothing of J3 Bots stays on the screen while quick access is closed; it shows the primary bot only, in the conversation the main window shows, with the same read mark and the same draft; and the Android app gets no counterpart.

That left how to build it. Three questions carry cost if answered wrong: what the small window runs, how it opens fast, and what it does where a window cannot be see-through.

## Decision

**Quick access is a second window of the desktop app, kept hidden, whose page is the web client's own on a connection of its own, drawing the primary bot's conversation with the conversation's components.** [Clients: Desktop](../architecture/clients.md#desktop) describes it; [Experience](../product/experience.md#a-quick-word-with-the-primary-bot) says what the operator sees.

- **A page of the web client, at `/quick`.** The window loads the app's own build, under the main window's preload script, sandbox and navigation rules. The page makes its own client, as a second browser tab does. The client runtime was built for several tabs of one origin: they share the credential and the drafts through the origin's storage, and read marks belong to the server.
- **Every window follows the drafts the others keep.** Until now a tab learned that another had changed a draft only as it next wrote it, and then put aside what the operator had typed there. Two browser tabs on one conversation are rare; the main window and quick access on the primary bot's are the normal case, and the first message typed in quick access after one sent from the main window was put aside and not sent. The storage port already told a window when another changed a table, and the outbox listened; the drafts now listen too, so a window shows a draft as another keeps it. The rule that a write claims the revision it read stays, for a window that was not told in time.
- **The conversation's components, fed by shared hooks.** The timeline's glue, the composer on a draft, the cards' intents, the open work folds and the files a conversation opens moved out of the main window's shell and source into modules both use. Quick access adds a header, a layout and its way in and out, and nothing that draws a message. What other work adds to the timeline or the composer shows in quick access because it is the same code.
- **Made once, kept hidden, loaded.** The window is created after the main window and its page follows the server from then on, so the shortcut only places the window and shows it. The page tells the app whether it has something to show (a primary bot, on a server it is paired with and has reached). Until it has, the shortcut shows the main window, which is where the operator finds out what is missing.
- **Three calls for its page, and none to move it.** The page reports whether it can show, asks to be hidden, and asks for the main window at a place: the conversation, or what a card in it leads to (the bot's browser tab, a routine, a room, a teammate conversation, a connector's sign-in), named from a closed list so each opens where it would from the main window. The main process takes them only from that window's page. The card's header is the window's handle, which the system drags, so no message moves the window, and it also drags on Wayland, where an app cannot move its own window.
- **The shortcut toggles, but does not take away what was asked for.** Pressed with the cursor in quick access, it closes it. Pressed while quick access is on screen and the operator is working in another app, it brings the cursor back to it.
- **It closes on `Escape`, its button or the shortcut, never on losing focus.** The operator put it there to glance at while they work.
- **Its place is kept per display, as a distance from the bottom-right corner,** and it is always whole on the display's work area.
- **See-through where the desktop composites, solid where it does not.** On X11 the app asks the X server whether a compositing manager runs. Without one the window is the card: square, with the face inside its header.
- **The card is the conversation in miniature** ("Cartão", the direction the owner chose among three shown): a low header with the bot's face at 36 px beside its name and state, a hairline, the messages, the composer. The window is see-through only around the card's rounded corners and its shadow. The card rises into place and the face pops in after it.

## Costs

- **A second connection and a second copy of the conversation in memory** for as long as the app runs, whether quick access is ever opened or not. The server sees one more socket of the same device.
- **The main window's source was reorganized** to share the conversation's wiring. Nothing changed on screen, but the change is wide for a file other work touches.
- **A draft kept in one window shows in the others at once, in browsers too.** The toast that said a draft had changed in another tab is gone with the surprise it explained; a Send that sent nothing because of such a change still says so, and text a window held that the device never kept is still offered back.
- **A change to the client runtime's draft store**, which the Android app shares. Its storage never announces a change, having one window, so nothing changes there.
- **Wayland gets less.** The compositor places the window and decides whether it stays above others. The app says so in its documentation and does not work around it.
- **The app speaks a little of the X protocol itself** to learn whether a compositing manager runs: Electron does not expose it.
- **What only a person at a real desktop can see was not seen.** The see-through window on Windows, macOS and a composited Linux desktop is built from Electron's documented options and has not been run; the desktop smoke runs the solid window under Xvfb.

## Rejected

- **A view inside the main window's page, moved into a small window** (one page, two `BrowserWindow`s sharing it, or the main window resized). One page cannot be in two windows, and resizing the main window loses its place and its conversation.
- **Create the window when the shortcut is pressed.** Loading the page and connecting takes seconds; the operator would type into nothing.
- **A separate, smaller client for quick access.** It would be the second copy of the conversation the owner asked not to have.
- **The main process decides whether quick access can show.** It knows nothing of the roster or the connection; the page does, and reports one boolean.
- **Close when it loses focus,** as launchers do. The operator's request is often followed by a wait; a card that vanishes when they click back into their work would hide the answer.
- **Move the window by messages from the page.** More surface for the page to ask of the main process, a drag that lags the pointer, and no drag at all on Wayland.
- **Always a transparent window.** Without a compositing manager it shows black around the card.
- **A panel that does not activate the app on macOS, and a toolbar-type window on Linux.** Both promise better focus and taskbar behavior and neither could be run here; a plain frameless window is the one whose behavior Electron documents on all three systems.
- **The two other card directions:** the bot's face, larger, sitting on the card's top edge and half outside it (the one first recommended and built), and loose bubbles with no card. The owner preferred the plain card; the second puts the conversation's lines and cards, drawn for a surface, straight onto whatever is behind.
- **Hand everything a card leads to over as "the conversation".** The first build did: "Open browser" on a help card landed on the conversation, where the operator had to press it again.
