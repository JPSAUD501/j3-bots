# 0004: Speech is a tool

**Status:** Accepted

## Context

A coding harness treats the model's final message as the answer. A teammate does not talk that way: it acknowledges at once, sends two short messages instead of one long one, and often has nothing to say at all, for example after a routine that found nothing.

## Decision

A bot delivers messages by calling J3 Bots' `say` tool. Only what passes through `say` (and `ask`, for questions) enters a conversation or a room. The model's ordinary reply text is private scratch space.

A bot speaks to a teammate the same way: `message_bot` is a tool call, pinned to its turn as `say` is, and it reaches one teammate, by bot id. Both conversations show the message as a card. A room is not a `message_bot` recipient: only `say` in a room turn speaks there, so who may post in a room has one answer. A teammate's reply is never the call's result: it is a `message_bot` of its own, which arrives as a later turn.

In a room, who must act next is part of the call too. `say` takes `mention`, the bot ids of the members who must act next, honoured only in a room turn: J3 Bots wakes exactly those, one at a time, and nobody else. It refuses, with nothing published, a mention outside a room turn, one of the bot itself or of a bot that is not a member, and one past the operator's fan-out limit. It never reads a mention out of the text.

The turn's final text is never published, because the bot may have used it for notes. If a turn opened by the operator ends without a delivery, J3 Bots wakes the bot once more to deliver it, and shows a notice if that fails too. A `say` with `done: true` closes the turn's delivery. It does not interrupt the run: an interrupt can drop the delivery of a delegated task's result to the run, and a bot may still be waiting on work it started. Interrupting a run is the operator's Stop and nothing else.

## Consequences

- Acknowledge-then-work, several messages per turn, and deliberate silence all become possible.
- The same tool addresses the conversation, a room, or the operator privately during a room turn.
- A room handoff is a structured choice J3 Bots can check and bound, like a teammate message. A name written in the text wakes nobody, so the tool description has to teach `mention`, and a bot that forgets it leaves the room waiting, which is the safe failure.
- Because a message to a teammate is a call J3 Bots applies, J3 Bots can refuse it where it starts: a recipient that is no teammate, work the operator stopped, or a chain or a fan-out past the operator's budget. Nothing past a budget is written, and nobody is woken to hear of it.
- Bot-to-bot exchanges cost a turn on each side. The tool description and the base prompt tell a bot not to answer an FYI or a thanks, and the budgets stop what the prompt does not.
- The transcript J3 Bots stores is exactly what was delivered, independent of the engine.
- A bot that keeps working after `done` keeps spending allowance. The tool's description tells it to end its turn, and the evals measure whether it does.
- The base prompt must override a strong habit of the host harness. Whether models hold to it over long sessions is the main risk, and the first thing the behavior evals measure.
- T3 Code gives Claude a tool of its own, `send_to_user`, for showing text mid-turn. The base prompt has to keep bots off it, and the adapter reports a call to it as host speech, which the server delivers rather than lose it.

## Rejected

**A teammate message returns the reply.** One call would carry a whole exchange. The sender's turn would hold a slot while the teammate works, two bots asking each other at once would wait on each other, and the teammate's own user could not see or stop the work as one of its turns.

**Mentions parsed from the text.** Nothing new to teach, since models already write `@Ana`. A quoted or negated name ("don't wait for @Ana") would wake her, a renamed bot would not be found, and the server would have to guess what a refusal of an unknown name means.

**The final message is the answer.** No prompt risk, works on every harness. No acknowledgement before long work, no silence, one message per turn, and room turns cannot be told apart from private ones.
