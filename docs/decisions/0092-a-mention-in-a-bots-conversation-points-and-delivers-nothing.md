# 0092: A mention in a bot's conversation points, and delivers nothing

**Status:** Accepted.

## Context

In a room, `@Name` says whom a message wakes ([Server: rooms](../architecture/server.md#rooms)). The owner asked for `@` in a bot's own conversation too, to name another bot or a room while talking to one bot: "ask @Wren for the photo", "tell @Launch week it is in". Typed as plain words, such a name is a guess the bot has to make among bots and rooms that may share a name, or be renamed.

A mention there could mean two things. It could deliver, as in a room: what it names is woken and reads the message. Or it could point: the bot the operator is talking to knows exactly which bot or room they mean, and does what their words ask with the tools it already has. Delivery would make a conversation a second way to write to a teammate or a room, beside `message_bot`, with its own rules for urgency, rounds and who saw what, and with none of the bot's judgment about what to pass on ([Server: teammate messages](../architecture/server.md#teammate-messages)).

## Decision

**In a bot's conversation, `@` offers the operator's other bots and the rooms that bot is a member of. A mention reaches no one: the conversation's bot reads each one resolved, and acts on the operator's words with `message_bot` and `read_room`.**

- **What `@` offers.** The operator's other bots, never the conversation's own, and the active rooms the bot is a member of. Hidden ones are offered too: a hidden bot or room stays reachable through everything that names it ([decision 0050](0050-bots-and-rooms-are-visible-or-hidden-and-the-operators-choice-wins.md)). A room the bot is not in is not offered, since the bot could neither post there nor read it, and `@everyone` belongs to a room.
- **A reference.** The server keeps the mentions with the message and wakes the conversation's bot, as for any message there. Nothing is written to the bot or room a mention names, and nothing wakes or notifies it.
- **What the bot reads.** After the message, each mention with its kind, id and name, a bot's title, and for a room whether the bot is still a member; then one line: none of them has seen the message; a question or a word for a teammate goes to it with `message_bot`, news for a room goes there with `message_bot` and the room's id, and what happened in one is a `read_room`; never say one of them saw what the bot did not send. There is no new tool.
- **What the server takes.** Up to six mentions, a bound of the contract, as for a room's: a longer list is a malformed request. None twice, each a bot that exists and is not the conversation's own, or an active room the bot is a member of; and none on a room's message, where an empty list, like an empty room mention in a conversation, mentions nothing. Anything else refuses the whole message with `Invalid("mentions")`, and nothing is written. A room's message keeps its rules exactly: members only, up to six, or `@everyone`.
- **A chip opens what it names.** A bot's chip opens its conversation and a room's chip the room, wherever a chip shows in a message, in conversations and rooms alike, on every client.
- **Protocol 11 holds.** `conversationMentions` is an optional field of `message.send` and of a message entry, apart from `mentions`, which is a closed set a client acts on. A roster snapshot with `conversationMentions: true` comes from a server that takes it, and a client offers `@` in a conversation only then. An older client drops the field and shows the message as it was typed, the names as plain text.

## Costs

- **The bot decides what happens.** A mention does nothing by itself: if the bot misreads the operator, the bot or room named hears nothing. The same judgment already carries `message_bot`, and the bot tells the operator what it sent and what came back.
- **Two fields name what a message mentions.** `mentions` for a room, `conversationMentions` for a conversation. One field would mean a new kind in a closed set, and so a protocol bump.
- **A mention names what was there when it was sent.** A room the bot has left since reads as one it is no longer a member of; a bot or room deleted since reads as a former one, and its chip turns back into the name in plain text.
- **Send again drops what moved.** A message refused because a room it mentions was archived or left meanwhile says which, by name, and goes again without the mentions `@` no longer offers.

## Rejected

- **Delivering the message to what it names.** It would be a second `message_bot`, without the bot's judgment of what to pass on, and it would wake rooms and teammates with words the operator wrote for someone else.
- **A tool for mentions.** `message_bot` and `read_room` already do what a mention asks.
- **Any room.** A bot can do nothing with a room it is not in, and the mention would read as a promise.
- **A room kind in `mentions`.** That set is closed: an older client would refuse every message that carried the new kind.
