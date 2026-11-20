# 0004: Speech is a tool

**Status:** Proposed

## Context

A coding harness treats the model's final message as the answer. A teammate does not talk that way: it acknowledges at once, sends two short messages instead of one long one, and often has nothing to say at all, for example after a routine that found nothing.

## Decision

A bot delivers messages by calling J3 Bots' `say` tool. Only what passes through `say` (and `ask`, for questions) enters a conversation or a room. The model's ordinary reply text is private scratch space.

One fallback: if a turn opened by the operator ends without any `say`, J3 Bots delivers the turn's final text. A bot that forgets the tool still answers.

## Consequences

- Acknowledge-then-work, several messages per turn, and deliberate silence all become possible.
- The same tool addresses the conversation, a room, or the operator privately during a room turn.
- The transcript J3 Bots stores is exactly what was delivered, independent of the engine.
- The base prompt must override a strong habit of the host harness. Whether models hold to it over long sessions is the main risk, and the first thing the behavior evals measure.
- T3 Code gives Claude a tool of its own, `send_to_user`, for showing text mid-turn. The base prompt has to keep bots off it, and the adapter should treat a call to it as speech rather than lose it.

## Rejected

**The final message is the answer.** No prompt risk, works on every harness. No acknowledgement before long work, no silence, one message per turn, and room turns cannot be told apart from private ones.
