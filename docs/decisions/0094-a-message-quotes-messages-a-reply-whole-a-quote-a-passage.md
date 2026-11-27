# 0094: A message quotes messages: a reply whole, a quote a passage

**Status:** Accepted.

## Context

The owner asked for what every chat app has: answering one message in particular, and pointing at the words of one. A conversation with a bot runs long, a room has several voices, and "the second one" or "what you said earlier" is a guess for the bot and for whoever reads it later. Two gestures cover it: **Reply**, on a whole message, and **Quote**, on a passage the operator selects.

T3 Code's own client has a Cite action on a selection of an assistant's text, which the agent receives as a quoted selector with words around it to find it again ([prior art](../research/prior-art.md); read in `pingdotgg/t3code` at `v0.1.13`, `apps/web/src/components/chat/AssistantSelectionToolbar.tsx` and `assistantCitations.ts`). J3 Bots owns its conversations, so it builds its own: what is quoted is checked by the server and kept with the message.

## Decision

**A message can quote up to three messages of the same conversation or room: at most one whole, which it replies to and shows first, and passages of their text, word for word. The quotes are kept with the message as they were when it was sent.**

- **One idea, two gestures.** Reply quotes a whole message, from the message's actions beside React, and on Android a swipe to the right as well. Quote takes the passage selected in one message: a small button by the selection on web, desktop and quick access; on Android, Quote part in the message's menu opens its text in a sheet to select from. A selection menu item of the system's own would need native work on Android for a gesture the sheet already gives.
- **What can be quoted.** Any message of the conversation or room, by the operator, the bot, another bot in a room, a routine's result, never J3 Bots' own. A message in another conversation or room cannot be: the server finds none there.
- **What the server takes.** `message.send` carries up to three quotes, a bound of the contract, each the id of a message and, for a passage, its text (up to 2,000 characters, trimmed). None twice, at most one whole, each a message of the same conversation or room, each passage in its message's text exactly as written. Anything else refuses the whole message with `Invalid("quotes")`, and nothing is written.
- **What the message keeps.** Each quote as it stood: whose message, when it was said, and the passage or the start of the message (up to 300 characters, and whether it went on). A quote reads the same if its source is deleted or changes, and a client draws it without fetching anything. Tapping one reads the conversation back until the source is there, scrolls to it and marks it briefly; a source that is gone says so where the quote is.
- **What the bot reads.** After the message, each quote in a data block of its own (who said it, `you` for the bot itself, when, and whether it is a whole message or a passage), and one line: a whole message is one it replies to, a passage the words it points at. A bot reads only messages of a conversation or room it is in, so a quote shows it nothing it could not read already.
- **A reply in a room addresses.** A message that mentions nobody and replies to a member's message wakes that member alone, as a mention of it would; mentions win when there are some, and `@everyone` stays everyone. A passage addresses nobody: the message wakes whom it would without it. The operator's messages and the bots' follow the same rule.
- **Bots reply, rarely.** `say` and a room post through `message_bot` take an optional `reply_to`, the id of a message their envelope gave, of the conversation or room the message goes to; anything else is refused with nothing sent. The tool says to use it only where an answer would be unclear otherwise. A bot quotes no passages.
- **Protocol 11 holds.** `quotes` is an optional field of `message.send` and of a message entry. A roster snapshot with `quotes: true` comes from a server that takes them, and a client offers Reply and Quote only then. An older client drops the field and shows the message's text alone.

## Costs

- **A passage is the text as written.** The server checks it against the message's raw text, so a client maps a selection back to it: code marks and a mention's `@` count, and a selection the mapping cannot place is not offered.
- **Quotes stay in their conversation.** Quoting a room's message in a bot's conversation would mean deciding who may read what across them; the operator copies the words instead.
- **`read_room` and a session's digest show no quotes.** They carry text; the quotes reach a bot in its envelope, with the message.
- **A kept quote can outlive its source.** A deleted message's words remain in the quotes of the messages that quoted it, as they remain in a bot's memory of the turn.

## Rejected

- **Quoting by reference only.** A quote fetched from its source each time would need a read per card, and would change or vanish with the source.
- **Passages found by context, as T3 Code's selector does.** J3 Bots' text renders almost as written, so an exact passage is checked once, by the server, and nothing has to be found again.
- **Threads.** A reply points at a message; it opens no thread, and the conversation stays one line.
- **Bots quoting passages.** A bot that wants to point at words writes them in its message.
