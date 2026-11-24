# 0038: A teammate conversation is a view of the teammate messages that already exist

**Status:** Proposed

## Context

Until 0.5.0, a message one bot sent another (`message_bot`) showed only in the two bots' own conversations: a `handoff` card in each, the sender's `sent` and the recipient's `received`, with one `handoffs` row tying them to the call that sent them. An exchange of a few messages back and forth left a card per message in both conversations, between each bot's talk with the operator, and an urgent one pushed a notification. The operator wants the talk between two bots in a place of its own, which they read and never write into, and their conversation with each bot kept to that.

Delivery already works from those cards: an urgent message's wake names the received card as its source, a held message names it as its handoff, a failed delivery's `handoff-failed` notice and its Retry reach the message through it, and a Stop marks the `handoffs` row. An entry also keeps its target and place for life (the `entries_fixed_place` trigger), and an entry belongs to exactly one bot's conversation or one room.

## Decision

**One teammate conversation per pair of bots, read from the messages as they are stored.**

- **Nothing moves.** A teammate message stays its two cards and its `handoffs` row, and delivery, Retry, Stops and their tests stay as they were. The teammate conversation lists, for each pair, the messages either bot sent the other, read from the received card, in the order they were sent.
- **A small index of its own, `pair_messages`** (migration 31): one row per message, with the pair (the two bot ids, sorted), the sender and recipient, both cards, and `seq`, its place among all teammate messages, given as it is sent and never given again. `message_bot` writes it in the transaction that writes the cards. The migration fills it from every earlier message, in the order their cards were written.
- **It outlives one bot, not both.** A `handoffs` row goes with the received card by design, so the index names the cards directly, each set to null when its bot's deletion takes its conversation: the other bot's card still says what was sent, and where it stands. A message with neither card left goes too, and a pair with no messages is no pair.
- **Addressed by its two bots.** A pair has no id: the two bot ids, sorted, name it everywhere, and a message is upserted by its `seq`. No engine id is involved.
- **Beside the roster, not in it.** `pairs.subscribe` lists every pair with its latest message for the roster's "Between bots" rows; `pairs.messages.subscribe` and `pairs.history` read one. A pair has no read mark, pin or section, so it is not a `RosterItem`. Protocol version 9.
- **Teammate messages stop calling for the operator.** A `handoff` card no longer makes its conversation unread, is no longer a bot's roster preview or its latest activity, and no longer notifies, urgent or not. A bot that needs the operator says so.

## What it costs

- A table kept in step with `message_bot`, and a trigger that removes a row once neither of its cards is left.
- The cards stay in the bots' own conversations, so clients group a run of them into one line there, rather than the server hiding them.
- A pair whose bots were both deleted is gone, as their conversations are.

## What was rejected

- **Moving the messages into a third kind of target.** It would need the entries table rebuilt to take a third target and every reference to a received card (wakes, held messages, notices, Retry) repointed, for nothing the operator would see.
- **The pair columns on `handoffs`**, with the sender's cards that lost their row to a deleted recipient read beside them. It would read the cards' JSON to find those, give a message a different id and place once its recipient is deleted, and sort two kinds of rows by two kinds of key.
- **One conversation per exchange.** It needs a rule for where an exchange ends just to exist, and multiplies rows; a pair is a stable place to go back to.
- **A conversation the operator writes into.** An operator's message there would have no one to answer it: the operator steers a bot, in its own conversation, or both in a room.
