# 0011: A room runs one turn at a time

**Status:** Accepted

## Context

A room's members are separate bots with separate sessions, and the dispatcher may run up to the concurrency budget of turns at once. Left to the ordinary rule, an operator's `@everyone` would start every member's turn together: each would answer the same message without seeing the others, the room would fill with overlapping replies, and the host's handoff could run beside the turn that is still deciding what to hand off. Each envelope also carries what its member has not seen, so two turns of one room running together would each miss what the other is saying.

The server already decides which wakes may go into which session from durable rows ([0010](0010-workers-reconcile-durable-state.md)), and wakes for different audiences never share a dispatch.

## Decision

At most one turn of a room runs at a time, across all its members.

- A room wake may start a turn only when no turn with the room as its audience runs and no dispatch of the room is `intended`, `accepted`, or `delivered` with no continuation pending. Nothing records that a room is busy: the dispatcher derives it from those rows, and the transaction that writes the dispatch reads it again, with the room still active and the bot still a member. The transaction that claims a room start's first send reads the same rule once more, without the start itself, since a turn the engine resumed after a usage limit's reset may have started since; a start that finds the room live, or its bot no longer a member, is released unsent and planned again. So is a room start never sent that cannot be sent when it is due, for want of a turn slot or because a usage limit holds it: its wakes wait as pending wakes, which do not make the room live.
- The room's pending wakes go one at a time, by priority and then in the order they were written, whichever member each wakes. The operator's room message has the operator's priority, so it goes before the bots' handoffs. While the next wake's member cannot get a turn slot, the operator's room wake to a member whose session can start a turn now (it holds a slot already, as with a pending continuation) goes first instead; whenever the next member can start, the order stands.
- The operator's room message may steer the running turn of its member for the same room, as their private message steers a turn in their conversation. That is the same turn, not a second one.
- A member's waiting wakes for one room share one envelope; wakes for two rooms never do.

## Consequences

- `@everyone` and a chain of handoffs read as a conversation: each member's envelope carries the replies before it, and a reply never crosses another.
- A room is as slow as its members in turn, and its next wake is the head of its line: while that member is busy elsewhere, every other member's wake for the room waits behind it, even a free member's. The member's other wakes go on as usual.
- A turn waiting for a usage limit's reset does not hold the room: other members take their turns meanwhile. Once the engine resumes it, its turn holds the room again, and a start written before that is not sent beside it. A start already sent when the engine resumes it still runs beside it: the engine resumes a continuation on its own.
- A member whose continuation holds the only free turn slot would hold the room's next wake for its whole wait, and with it the operator's word to that member, which would drop the continuation. That is why the operator's wake to such a member may go first: it takes no slot the next member could have.
- A room start written and never sent would hold the room as long as it stays `intended`. One whose files failed to stage waits for its backoff, and a member's continuation may take the only slot meanwhile: the start could then never be sent, and the room's next wake, the operator's word to that member included, could never go. Releasing it when it is due and cannot be sent ends that: its wakes go back to the room's line in their order, and the operator's exception applies. It cannot loop: its wakes are planned again only when their member can start, and a release writes nothing new. A new dispatch counts its staging failures from zero, so a file that keeps failing to stage while the slots stay contended is tried again for longer than one dispatch's bound; each try needs a slot first.
- A dispatch whose recovery gave up (`unresolved`) does not hold the room either, and the engine can still apply its key: its turn would then run beside the turn that started in the meantime. Holding the room for as long as the key could land would hold it for up to a day with no way to release it.
- A turn the engine starts for background work a room turn left continues that turn's work for the room ([0013](0013-background-work-belongs-to-the-turn-that-started-it.md)), and holds the room while it runs, but the engine starts it on its own: like a continuation the engine resumes, it may start beside another member's turn for the room.
- A busy room holds no slot of the concurrency budget: its next wake is simply not planned yet, so other bots' work goes on.
- A crash can never leave a room marked busy, since there is no mark. The cost is a short read of a room's dispatches and turns when its wakes are planned, kept small by partial indexes.
- What a member has seen is derived the same way, from the room's newest entry each of its dispatches recorded, so a dispatch the engine never applied leaves its entries unseen for the next envelope.

## Rejected

**Members of a room run in parallel.** Faster for an `@everyone` of independent questions. The replies would repeat each other, and the budgets that bound a chain of handoffs would have to count turns that started from the same message at once.

**A busy flag on the room.** One read instead of two. Every path that ends a turn, a Stop, a lost session, a failed send, a late delivery, would have to clear it, and one that missed would hold the room for good.

**The room's oldest wake by time alone.** One order for everything in the room. The operator's message would wait behind every handoff written before it, so they could not redirect a room that had started a long chain.
