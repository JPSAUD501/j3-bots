# 0011: A room runs one turn at a time

**Status:** Superseded by [0040](0040-the-members-of-a-room-run-in-parallel.md)

## What it decided

At most one turn of a room ran at a time, across all its members. The room's pending wakes went one at a time, by priority and then in the order written, whichever member each woke, and each member's envelope carried the replies before it. The operator's room message could steer its member's running turn for the room, and could go first when the room's next member could not get a turn slot and the operator's member held one. A room start written and never sent was released when it could not be sent, so it would not hold the room.

It kept replies from crossing, kept a handoff from running beside the turn still deciding it, and let each member read every reply before its own.

## Why it was dropped

In 0.6.0 a room message that mentions nobody wakes every other member ([0039](0039-a-room-has-no-host.md)), and the owner wants a room to behave like a group: when they write, every member starts answering at once. One turn at a time would answer the operator's message to a room of four with four turns in a row, and queue every reply's wakes behind them. Overlapping replies are now accepted instead, and what a member has not seen reaches it in its next envelope; [0040](0040-the-members-of-a-room-run-in-parallel.md) records the decision and its costs.
