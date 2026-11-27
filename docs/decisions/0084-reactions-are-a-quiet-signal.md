# 0084: Reactions are a quiet signal, owned by J3 Bots

**Status:** Accepted.

## Context

In a chat, an emoji under a message says "seen", "thanks" or "yes, go ahead" without a reply. The owner asked for the same in J3 Bots, as chat apps and chat bots already do it: the operator reacts to any message, and a bot reacts too, sparingly. A reaction is part of the conversation, which J3 Bots owns ([decision 0003](0003-conversation-is-not-session.md)); the engine has no notion of one.

Two things make reactions harder than they look for bots. A reaction on a bot's message may be the operator's answer to an offer ("Shall I book it?" 👍), so the bot must see it; but most reactions need no answer, and a bot that replied to each one, or showed a turn of work for it, would be noise. And people change their minds: a 👍 swapped for a ❤️ a second later is one reaction, not two.

## Decision

**A reaction is one emoji per person or bot per message. The operator's reaction on a bot's message wakes only that bot, once it settles, in a quiet turn that leaves no trace unless the bot speaks. Every other reaction waits for the bots' next turns. Bots react through a `j3` tool.** The details are in [Server: reactions](../architecture/server.md#reactions).

- **One each, as in WhatsApp.** Another emoji replaces the reactor's; the same one again takes it off. A message carries its reactions, grouped by emoji under it as small pills with a count; who reacted is a long press or a hover away.
- **Stored apart from the message.** Reactions are a table of their own, read with each message. A later write of the message never loses them, and a change to them is sent to clients as a change of the message.
- **The operator's reaction on a bot's message wakes that bot alone**, in pairs and rooms alike, as a `system` wake once four seconds pass with no further change. A change of mind reaches the bot once, as it ended; a reaction taken off within the four seconds wakes nothing. A bot that is busy is not woken: the reaction rides its next turn.
- **A quiet turn.** The bot sees who reacted with what on which of its messages. By default it says nothing; it acts only when the reaction answers something it offered and its instructions or memory say that emoji means yes. Until it speaks, the turn shows no work, and if it ends without speaking, nothing it did, failure included, shows in the conversation.
- **Every other reaction wakes no one.** A reaction on the operator's own message, on another bot's, or by a bot reaches each bot there in its next turn, as the reactions then stand.
- **Bots react with `react`**: a message by the id its envelope gives it, one emoji, and `done: true` when the reaction is the whole reply. Never on its own message, never notifying anyone. The prompt asks bots to react rarely, mirroring the operator, never on a request still unanswered.
- **Exactly one emoji.** The server takes what Unicode defines as one emoji (`\p{RGI_Emoji}`), flags and families included, and nothing else. The clients offer a quick bar of six and a picker of the system's own emoji, so no emoji library or image ships with them.
- **Protocol 11 holds.** `message.react` and `MessageEntry.reactions` are additive. A client offers reacting only on a message that carries `reactions`, which only a server that takes `message.react` sends; an older client drops the field.

## Costs

- **Four seconds.** The bot learns of a reaction four seconds after the operator's last change, and a reaction meant as "go ahead" waits that long. Shorter would wake the bot for a slip of the finger.
- **A quiet turn's early steps are not shown.** A bot that reads its memory before deciding to act shows its work only from its first word. What it did before was a look, not work on the operator's behalf.
- **A reaction can still start a turn that does nothing.** It costs a short turn of the bot's AI, which is why only the operator's reaction on the bot's own message starts one, and why it waits out changes of mind.
- **The bot names messages by id.** Its envelope gives the ids of the operator's messages and a room's entries; `read_room` gives none, so a bot reacts only to what an envelope showed it.
- **No reaction while the client is offline.** A reaction is a request, not a queued command: a client that cannot reach the server says it was not saved.

## Rejected

- **Every reaction as a wake.** Bots would answer emoji with words, and a room of bots would wake each other with reactions.
- **Reactions as a normal turn.** The operator would see a turn of work, or a notice that the bot did not reply, for a 👍 that needed nothing.
- **Reactions only in the next turn, never a wake.** The operator's 👍 on "Shall I start?" would wait for their next message, which defeats the point of answering with an emoji.
- **Keeping reactions in the message's body.** Every write of a message would have to carry them back, and a bot's delivery could erase the operator's reaction.
- **An emoji library for the picker.** The system's emoji cover what people react with, at no cost to the app's size or its license.
