# 0011: A room runs one turn at a time

**Status:** Accepted

## Context

A room's members are separate bots with separate sessions, and the dispatcher may run up to the concurrency budget of turns at once. Left to the ordinary rule, an operator's `@everyone` would start every member's turn together: each would answer the same message without seeing the others, the room would fill with overlapping replies, and the host's handoff could run beside the turn that is still deciding what to hand off. Each envelope also carries what its member has not seen, so two turns of one room running together would each miss what the other is saying.

The server already decides which wakes may go into which session from durable rows ([0010](0010-workers-reconcile-durable-state.md)), and wakes for different audiences never share a dispatch.

## Decision

At most one turn of a room runs at a time, across all its members.

- A room wake may start a turn only when no turn with the room as its audience runs and no dispatch of the room is `intended`, `accepted`, or `delivered` with no continuation pending. Nothing records that a room is busy: the dispatcher derives it from those rows, and the transaction that writes the dispatch reads it again, with the room still active and the bot still a member.
- The room's pending wakes go one at a time, by priority and then in the order they were written, whichever member each wakes. The operator's room message has the operator's priority, so it goes before the bots' handoffs.
- The operator's room message may steer the running turn of its member for the same room, as their private message steers a turn in their conversation. That is the same turn, not a second one.
- A member's waiting wakes for one room share one envelope; wakes for two rooms never do.

## Consequences

- `@everyone` and a chain of handoffs read as a conversation: each member's envelope carries the replies before it, and a reply never crosses another.
- A room is as slow as its members in turn, and its next wake is the head of its line: while that member is busy elsewhere, every other member's wake for the room waits behind it, even a free member's. The member's other wakes go on as usual.
- A turn waiting for a usage limit's reset does not hold the room: other members take their turns meanwhile, so the engine can resume it beside another member's room turn.
- A dispatch whose recovery gave up (`unresolved`) does not hold the room either, and the engine can still apply its key: its turn would then run beside the turn that started in the meantime. Holding the room for as long as the key could land would hold it for up to a day with no way to release it.
- A busy room holds no slot of the concurrency budget: its next wake is simply not planned yet, so other bots' work goes on.
- A crash can never leave a room marked busy, since there is no mark. The cost is a short read of a room's dispatches and turns when its wakes are planned, kept small by partial indexes.
- What a member has seen is derived the same way, from the room's newest entry each of its dispatches recorded, so a dispatch the engine never applied leaves its entries unseen for the next envelope.

## Rejected

**Members of a room run in parallel.** Faster for an `@everyone` of independent questions. The replies would repeat each other, and the budgets that bound a chain of handoffs would have to count turns that started from the same message at once.

**A busy flag on the room.** One read instead of two. Every path that ends a turn, a Stop, a lost session, a failed send, a late delivery, would have to clear it, and one that missed would hold the room for good.

**The room's oldest wake by time alone.** One order for everything in the room. The operator's message would wait behind every handoff written before it, so they could not redirect a room that had started a long chain.
