# 0042: A room counts rounds, not messages

**Status:** Accepted

Supersedes the room's count of messages in [0039](0039-a-room-has-no-host.md), its loop guard. Everything else in 0039 stands.

## Context

0039 bounded how long a room's members talk among themselves by counting their messages since the operator last wrote there: closing from 6, quiet past 12. That number assumed members who mostly took turns. Since 0.6.0 every member reads every message, and members run in parallel ([0040](0040-the-members-of-a-room-run-in-parallel.md)), so a message to the whole room of six gets five or six replies at once. The count then measured the room's size more than its talk: a room of six was already closing after the operator's first message drew its replies, and went quiet one exchange later, while a pair of bots handing work back and forth got twelve exchanges.

The owner compared this with the product they use as the reference. There, in a group of six bots, a numbered test showed the opening message drew five replies at once and the next exchange three; the members woken for the exchange after that were told the group was closing, and nobody spoke after. The guard there is the number of rounds of bots answering bots, the same in a group of two or of six.

## Decision

**A room counts rounds of its bots answering each other since the operator's word last reached it, and the same two thresholds hold in a room of any size.**

- **The operator's word is round 0:** their message in the room, a bot's kickoff (only on their word), or the first post of a turn they spoke in that relays their request to the room ([#270](https://github.com/JPSAUD501/j3-bots/pull/270)).
- **A bot's message answers what its turn was shown.** It is one round past the newest round among the room messages the turn's envelopes carried since that word, round 1 when they carried none of it. Waiting wakes that share an envelope count from the newest round among them, and a steer of the operator's into a running turn is shown to it like any envelope. A turn that goes on with another's work (a continuation, a turn the engine started for a turn's background work) counts what that turn was shown too. The messages one such turn posts take the same round, however many it says, until the operator's word reaches the room again: a steer of theirs makes the turn's later messages answer it.
- **A post from a turn shown nothing of the room** (a teammate's turn, a routine's, the bot's own conversation, or a turn the engine started on its own for no room turn's work) answers the whole room: one round past its newest since that word, each time it posts there.
- **Closing from round 3** (`ROOM_CLOSING_ROUND`): an envelope whose reply would take round 3 or later tells the member the conversation is closing, so it speaks only if it is essential.
- **Quiet past round 4** (`ROOM_QUIET_ROUND`): a bot message of round 5 or later is posted but wakes nobody. The room shows one `chain-stopped` notice (`limit: "room"`) and waits for the operator's word: until then no bot's message there wakes anyone, a slower member's late answer to an earlier round included.
- So after the operator writes, the first two rounds of replies run as usual, the third and fourth only where they are essential, and then the room waits for them, in a room of two as in a room of six.
- **Each message keeps its round** (`entries.room_round`), and each room dispatch the round its reply takes (`dispatches.room_round`). Where the operator's latest word is, is read from the messages, not kept in a counter: `rooms.bot_streak` goes.
- **Unchanged:** mentions decide whom a message wakes (0039); members run in parallel (0040); teammate chains keep their hop and fan-out budgets; a relay carries the operator's word once per turn.

## Consequences

- Migration 0034 adds the two columns, drops `rooms.bot_streak`, and starts every room at round 0: rounds were never recorded, so each existing message counts as the operator's word, and a room dispatch not yet answered takes round 1. A room's bots get their rounds again once, from the upgrade.
- A pair of bots working through a task by handing it back and forth gets four exchanges after the operator's message where it had twelve. A task that needs more asks the operator, who can say "go on" in one message.
- A room turn that posts several messages takes one round: the base prompt's limit of three messages a turn is what bounds a turn, not the guard. A turn outside the room takes a round with each post there, since it answers no envelope of the room.
- No protocol change: clients never read the numbers, and `chain-stopped` with `limit: "room"` is the same notice.

## What was rejected

- **Keeping the count of messages.** It makes the room's size decide how many exchanges the room gets: a room of six closes on its first replies, a pair talks for twelve. No threshold suits both.
- **Making the numbers settings.** A setting the operator raises to let one task finish stays raised for every room, and the reference product has none. The operator's word already lets a room go on.
- **Counting from the room's newest round for every message.** A member that answers an earlier message, one posted while its turn waited, would take a round it did not answer, and a burst of parallel replies would push the room through its rounds at once.
