# 0040: The members of a room run in parallel

**Status:** Accepted

Supersedes [0011](0011-a-room-runs-one-turn-at-a-time.md).

## Context

Until 0.6.0 a room ran one turn at a time across all its members ([0011](0011-a-room-runs-one-turn-at-a-time.md)): its wakes went one by one, by priority and then as written, and each member's envelope carried the replies before it. That suited a room where the operator's message woke one bot and a reply woke only the members it mentioned.

In 0.6.0 a room message that mentions nobody wakes every other member, the operator's and a bot's alike, and a message that mentions members wakes them ([0039](0039-a-room-has-no-host.md)); every member reads every message. Under one turn at a time, the operator's message to a room of four would be answered by four turns in a row, each a minute or more, and every reply would queue three more behind them. The owner wants a room to behave like a group: when they write, every member starts answering at once, and each speaks when it has something to add.

The one-turn rule protected five things: replies that never overlap; a member's handoff never running beside the turn still deciding what to hand off; what each member has seen; a usage-limit continuation that the engine resumes on its own; and a room start written but never sent, which held the room while it stayed unsent.

## Decision

**A room wake starts a turn when its member's session can, as any other wake does.**

- **Within the concurrency budget, nothing else.** A room wake is planned into its member's main session when that session is idle and a turn slot is free or already held by it ([Server](../architecture/server.md#2-the-server-holds-waiting-wakes)). Nothing reads whether another member's turn for the room runs, so the operator's message starts every member's turn at once, as far as the slots allow, in the order it woke them.
- **A member runs one turn at a time.** Its room wakes go into its main session, which takes one turn at a time, so it never runs two turns for the same room at once. What reaches it while its room turn runs waits, and its waiting wakes for the room share its next envelope. Wakes for two rooms never share one.
- **The operator's word steers.** The operator's room message steers each member's running turn for that room, as their private message steers a private turn, so one message redirects every member already answering. Like any room envelope, the steer carries what the member has not seen, the replies posted since its turn began included, and their waiting wakes go with it.
- **What a member has seen is its own.** It is derived from its own dispatches, each recording the room's newest entry when its envelope was written. Two members' envelopes written at the same moment each carry what that member has not seen, and a reply posted while a member's turn runs reaches it in its next envelope.
- **A room start that cannot be sent when it is due is still released.** For want of a turn slot, or held by a usage limit, it goes back to pending wakes rather than wait unsent. It no longer holds anything, but its envelope carries the room as it was when it was written, and the other members may speak for as long as it waits: planned again once it can start, it carries what they said.
- **The room's guard and Stops do not depend on the order of turns.** What keeps bots from answering each other for good is counted for the room, from its messages since the operator last wrote there ([0039](0039-a-room-has-no-host.md)), so turns running at once count no differently from turns in a row. A room's Stop records a target for every member session with work for the room and stops them in the same pass.

## What it costs

- **Replies overlap.** Members answering the same message at once do not see each other's replies, and two may say the same thing. A group of people does the same. The envelope's closing lines tell a member to read what is already said and to end its turn without a word when it has nothing to add ([Prompt architecture](../prompts/architecture.md#wake-envelopes)), and each member's next envelope carries what the others said.
- **More turns for one message.** A reply that mentions nobody wakes every other member, and a member already running takes the replies after its turn, in one envelope: a burst of replies is one more turn for it, not one per reply. The room's guard bounds how long bots go on answering each other; coalescing bounds how often one member runs for it.
- **The concurrency budget decides how parallel a room is.** With the default of two turns, a room of four starts two members at once and the others as slots free, each with the replies before it. The operator raises the budget for more.
- **The allowance is spent sooner.** Parallel members spend the same turns at once rather than one after another.
- What 0011 needed to keep a room in line goes with it: the room's order of wakes across members, the operator's exception for a member that holds a slot, and the reads of whether anything of the room is live. A continuation the engine resumes, a dispatch whose recovery gave up, and a turn the engine starts for background work may run beside other members' turns, as any member's turn now does.
- The partial indexes on the room's open dispatches, running turns and pending wakes stay: the room's work state (`Room.work`) reads them.

## What was rejected

- **One turn at a time (0011).** Every member reading every message makes a room as slow as all its members in turn, and a reply sets off a queue of turns the operator watches go one by one.
- **Parallel for the operator's message, one at a time for the bots' replies.** Fewer overlapping replies after the first round, but two rules for one room, and a member's reply would wait behind members still answering the operator.
- **Steering a member's running turn with another member's reply alone.** The member would see the reply sooner. Only the operator's word steers a turn, and replies reach a running turn only beside it ([0005](0005-j3-bots-owns-wakes.md)): a bot's message steered into another bot's turn would land in the middle of work the member planned without it, and an engine that runs a steer as a new attempt of the turn would restart a member every time another spoke.
