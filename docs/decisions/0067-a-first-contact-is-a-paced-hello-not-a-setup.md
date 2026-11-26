# 0067: A bot's first contact is a hello in a few paced messages, not a setup

**Status:** Accepted.

## Context

A new bot opened its conversation with one message: a short hello and one question. Its base prompt then ran a setup from that hello on: where the operator's work is kept (accounts, repositories, folders), then how they like replies, with a pinned "Setup complete" to end it. In use, the first thing a person met was something like "Hi, João! I'm Jotinha. Where do you usually keep the work you want my help with?": a form question before the bot had said what it was for. Non-technical people are one of the main audiences, and many have no answer to that question yet.

Two things shape the fix. A message from a person in a chat arrives as a few short lines, not one block. And a model that is asked for several messages may send them as one batch of tool calls, which reach the server within milliseconds of each other.

## Decision

**A bot's first contact is a hello in two or three short messages, paced by the server with the bot shown typing between them, and it asks no setup question.**

- The base prompt's `first-run` rule asks for two or three short `say`s, each sent once the one before has returned, only the last with `done: true`: first the bot's name and who it is, in a line and in its own voice; then two or three concrete things it could do for this operator, fitting its job; last, one easy question to start knowing them. The question is what to call them when the event says no bot knows (the rule that one bot asks, from #178 and #322, is unchanged), otherwise something light about what they would like a hand with. A bot made from a template offers what its template's job names and starts none of it. A bot whose job names work to begin says hello and starts it, as before.
- The setup is removed. Where the work is kept, which accounts, folders or connections to use, and how the operator likes replies are asked only when a task needs the answer and memory does not hold it.
- A bot made for a room, whose hello `start_room` cancels, meets the operator in the room: until it first speaks, its room envelope's closing line asks it to open with who it is and to ask them nothing to get to know them.
- The server paces a first contact's messages. A `say` that follows another in the same turn waits, before it is posted, for as long as typing it would take (0.5 s plus 14 ms a character, between 0.9 and 2.6 s), less the time since the one before. A bot's `say`s are posted one at a time; the prompt's rule of one `say` after the other is what keeps a hello in order. While a message waits, the bot's `thinking` or `working` state carries `typing: true`, an additive field that decodes as false from an older server, and clients show "Typing". A Stop since the message before drops the next one.
- A turn is a first contact when it delivers the bot's `first-run` wake, or when the bot was made for a room and had not spoken when the turn started, read from its conversation and from the `say`s its sessions posted, which outlive the rooms it spoke in. Other turns are not paced.

## Costs

- A hello takes two or three seconds longer to finish, and holds its turn for that long.
- The pacing and the typing mark live in the server's memory. A restart while a hello types ends that turn anyway, so nothing is left behind, but a server that loses the last message's time, for a bot whose turn survives, posts the next message at once.
- A bot that asked nothing at first learns where the operator's work is only when a task needs it: the first such task begins with a question.
- An older client shows the waits as "Thinking", since it does not read `typing`.

## Rejected

- **The client paces the messages it receives.** Every client would need the same logic, a reload or a second device would show the hello differently, a notification would announce a message the conversation had not shown yet, and a Stop could not drop a message the server had already posted.
- **Pacing every turn.** Outside a first contact, a bot speaks again only for a result, a blocker or a change of plan, so its messages are already apart. Holding them would delay real answers.
- **One message with paragraphs.** It reads as a block, which is what the owner's complaint was about.
- **Keeping a shorter setup.** Any question about where things are kept, asked before the operator asked for anything, is the same first impression.
