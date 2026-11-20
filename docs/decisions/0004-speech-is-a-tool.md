# 0004: Speech is a tool

**Status:** Proposed

## Context

A coding harness treats the model's final message as the answer. A teammate does not talk that way: it acknowledges at once, sends two short messages instead of one long one, and often has nothing to say at all, for example after a routine that found nothing.

## Decision

A bot delivers messages by calling J3 Bots' `say` tool. Only what passes through `say` (and `ask`, for questions) enters a conversation or a room. The model's ordinary reply text is private scratch space.

The turn's final text is never published, because the bot may have used it for notes. If a turn opened by the operator ends without a delivery, J3 Bots wakes the bot once more to deliver it, and shows a notice if that fails too. A `say` with `done: true` closes the turn's delivery. It does not interrupt the run: an interrupt can drop the delivery of a delegated task's result to the run, and a bot may still be waiting on work it started. Interrupting a run is the operator's Stop and nothing else.

## Consequences

- Acknowledge-then-work, several messages per turn, and deliberate silence all become possible.
- The same tool addresses the conversation, a room, or the operator privately during a room turn.
- The transcript J3 Bots stores is exactly what was delivered, independent of the engine.
- A bot that keeps working after `done` keeps spending allowance. The tool's description tells it to end its turn, and the evals measure whether it does.
- The base prompt must override a strong habit of the host harness. Whether models hold to it over long sessions is the main risk, and the first thing the behavior evals measure.
- T3 Code gives Claude a tool of its own, `send_to_user`, for showing text mid-turn. The base prompt has to keep bots off it, and the adapter reports a call to it as host speech, which the server delivers rather than lose it.

## Rejected

**The final message is the answer.** No prompt risk, works on every harness. No acknowledgement before long work, no silence, one message per turn, and room turns cannot be told apart from private ones.
