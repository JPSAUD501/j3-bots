# 0102: A bot's card opens from its face and name

**Status:** Accepted.

## Context

The owner asked for a card over a bot that tells, at a glance, who it is and what it is up to, and lets them act on it without leaving where they are. Until now that took opening the bot's details, which replaces what the operator was reading on a narrow window, and says much that the operator rarely needs at that moment (its model, its memory, its files).

What was open:

- where the card opens, and how, so it is there when wanted and never in the way of typing;
- what it says, and from what: the client already holds the bot, its rooms and, while its details are open, its routines;
- whether a message can be sent from it, and how its delivery is shown;
- what "who created it" can say, since the server only kept the maker while that bot exists;
- the same card on Android, where nothing hovers.

## Decision

**One card per bot, opened from its face or name after a short rest of the pointer or of keyboard focus, gone when they leave, on Escape or when the operator types elsewhere. On Android, a long press on the face opens the same card in a sheet. It says only what the client already holds, plus who created the bot, which the server now records.**

### Where it opens

- **On the web and the desktop app**: wherever a bot is named: its roster row, a speaker's face and name in a room or a teammate conversation, a room's members and a bot's teammates in the details, a bot's mention chip in a message, and quick access's face. A room's face and the composer's chips open none.
- It opens after the mouse rests there for 500 ms, or keyboard focus that shows rests on a roster row, a teammate row or a mention chip for as long. A speaker and a room member are not controls, so they open it on the pointer only. From one bot to another it takes 150 ms. Touch on the web opens nothing.
- It goes 250 ms after the pointer has left both the bot and the card, when focus leaves both, or on Escape, which gives focus back to the bot without opening the card again. Any key other than a modifier, pressed outside the card, cancels a card about to open and closes one the pointer opened: the card never stands between the operator and what they are typing. Opening never moves focus; Tab from the focused bot enters the card.
- The timings are tokens (`cardTiming`), and the card's coming and going is the popover's pop and fade, still under reduced motion ([decision 0052](0052-motion-follows-palco.md)).
- **On Android**: a long press on the bot's face in its roster row (the rest of the row keeps the roster menu, and a pinned bot's avatar keeps its menu), on a speaker's face or name, on a bot's mention chip, on a room member, or on a teammate. A screen reader reaches it as an action of those. The card is a sheet.

### What it says

From the top: the bot's face with a dot for where it stands (working, waiting for you, free, paused by a usage limit; a bot stopped by another problem takes the paused dot with its own words), its name and title; four actions (talk, start a room with it, its routines, its details); a quick message; while it works, what it is doing in one line with its little ones and since when; what it is for, in two lines; and about it: who created it and when, its routines with their next run, and the active rooms it is in, three by name and a count of the rest; then See details. Nothing technical: the model, provider and settings stay in the details.

Its words come from `client-runtime` (`cardLines`), the same for every client. Its routines are read while the card shows, unless the bot's details already hold them; everything else is in the roster the client has. No new read was added for the card.

### The quick message

It goes through `J3Client.send`, the composer's own path through the outbox, to the bot's conversation, which stays closed. The field empties as it goes. Under it, one line says where the message stands: "Sending…", "Sent to Wren." with Open the conversation, a limit it broke (and the text comes back to the field, since nothing was sent), that the bot is gone, or that it was not sent and waits in the conversation, where Retry is.

### Who created it

Bots now record who made them, the operator or a bot (`made_by`, migration 0066), beside the maker bot's id the server already kept while that bot exists. A bot made by a bot that was deleted since still says a bot made it. A bot is made by a bot only through `create_bot`, which only the primary bot has, only in a turn the operator spoke in (**Read** in this repository's server, not in the engine), so the card says "at your request". Bots made before the column existed are known to be a bot's while their maker exists; the others are unknown, and their card says only when they were created. The contract carries it as `Bot.madeBy`, an optional field an older client ignores; an older server sends none, and the card falls back the same way.

## Consequences

- The card is a popover with no trigger of its own: the bots that open it stay what they were (a row, a chip, a name), and keep their own click and menu.
- Quick access's card opens the main window for what it cannot hold: a bot's details (`details`) and a new room with the bot (`new-room`), two new places the desktop app's page may ask for.
- An older server sends no `madeBy`: every card it serves says only when the bot was created.
- On Android the card is one per screen, so what it opens is pushed from where the operator is, also over a bot's details.

## Alternatives considered

- **A card that opens on click.** A click on a bot already opens its conversation, and the card is for a glance.
- **Base UI's preview card.** It cannot be reached by the keyboard, and the card holds controls.
- **Inferring "made by you" from a missing maker.** A maker deleted since leaves the same empty column, so the card would credit the operator with bots they asked a bot to make.
- **The model and permission mode on the card.** They answer a question the operator asks of the details, not of a glance.
