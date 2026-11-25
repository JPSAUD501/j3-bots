# 0039: A room has no host, and a message for nobody wakes everyone

**Status:** Accepted. Its loop guard, the room's count of messages, is superseded by [0042](0042-a-room-counts-rounds.md).

## Context

Until 0.5.0 a room had a host: a member the operator picked, which every operator message that mentioned nobody woke alone. The other members heard only what named them, or `@everyone`; a bot's room message woke only the members it mentioned, at most the fan-out budget of them. So a message for nobody reached the host and no one else: the other members never saw what the room was saying unless something addressed them. The host also tied rules to it: an active room needed one, deleting it handed the room to the next member, and a failed message's Retry went "to the host".

A room kept a loop from running on by counting hops, as teammate messages do, against a hop limit of its own. Each wake a bot's room message caused carried one more hop than the furthest the speaking turn had delivered, so the count followed one chain through the members.

The operator uses a room as a group chat with several AI members. They expect every member to follow what is said there, a message for one member to go to that member, a message for nobody to reach everyone, and the talk among the bots to die down once it has run its course, until they write again. The design was chosen to match that.

## Decision

**A room has no host. A message that mentions members wakes only them; one that mentions nobody wakes every other member; `@everyone` wakes every member and asks each to answer. A room counts its bots' messages since the operator last wrote there, in place of hops.**

- **Members are equal.** A room has two to six members, in order. `start_room` puts the bot that calls it first. The host, its column (`rooms.host_bot_id`) and every rule that needed one go: an active room is valid with any two members, and deleting a bot only archives a room it leaves with fewer than two.
- **A mention says whom a message wakes.** The rule is the same for the operator's message and a bot's (`say`, `message_bot` to the room, or a kickoff): mentioned members alone are woken, and a message that mentions nobody wakes every member but its author. `@everyone`, which only the operator writes, wakes every member and asks each to answer. A bot's message never wakes its author. Every member reads every message, in its next envelope, whether that message woke it or not. A room message's mentions have no fan-out limit; a mention list holds at most six members.
- **Why a member is woken chooses its closing line.** `kickoff`, `addressed` (it is mentioned), `everyone`, `user` (the operator wrote to the whole room) or `member` (a member did). When several wakes share one turn, the strongest wins, in that order. A member's message to the whole room asks less of the others than the operator's: answer only what asks something of you, or what nobody said.
- **What reaches a member while it waits or runs shares its next envelope.** A burst of replies is one turn for each member it wakes. There are no delivery rounds and no timer.
- **The room's count is the loop guard.** The room counts its bots' messages since the operator last wrote there (`rooms.bot_streak`). Any message of the operator's in the room resets it, and so does a kickoff, which counts as the operator's word: a bot starts a room only in a turn the operator spoke in. From 6 (`ROOM_CLOSING_AFTER`), every room envelope tells the member the conversation is closing, so it speaks only if it is essential. A bot message that takes the count past 12 (`ROOM_QUIET_AFTER`) is posted but wakes nobody; the room shows one `chain-stopped` notice (`limit: "room"`) and stays quiet until the operator writes. Both numbers are fixed, not settings.
- **Hops are for teammate chains only.** Room wakes carry no hops, and a room has no hop limit. A teammate message a member sends from a room turn starts a chain of its own, held to the hop and fan-out budgets as before.
- **Protocol version 10.** `Room`, `room.create` and `room.update` have neither a host nor a hop limit.

## Consequences

- Migration 0032 rebuilds `rooms` without `host_bot_id` and `hop_limit`, with `bot_streak` at 0 for every room, and renames the stored room wake reasons it replaced: `host` becomes `user`, `mentioned` becomes `addressed`. Entries and their `@everyone` mentions are untouched.
- Clients drop the host and the hop limit from creating, showing and editing a room.
- A message to the whole room of six is up to five turns where it was one, each spending its member's allowance; the closing lines carry the weight of keeping them short, and the room evals measure how well they hold.
- An unaddressed question has no member bound to answer it. A member whose part it is answers; when none sees it as its own, the room stays silent and the operator names one.
- A room's talk among its bots is bounded at twelve messages per word of the operator's, however many members it has.

## What was rejected

- **Keeping the host.** A message for nobody reaching one member leaves the others blind to what the room says, which is what the operator objected to.
- **Waking every member for every message, mentions included.** A message for one member would cost a turn of each other member and fill the room with replies nobody asked for.
- **Delivery rounds, or a timer that waits for a burst to end.** Coalescing each member's waiting wakes already gives one turn per burst, without delaying anyone.
- **Counting hops per chain in rooms.** Every member's answer to a kickoff extends the chain, so a large room reaches the limit while still answering the operator's own message. A count of the room's bot messages since the operator's last word measures what matters: how long the bots have talked among themselves.
