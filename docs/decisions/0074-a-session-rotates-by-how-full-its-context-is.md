# 0074: A session rotates by how full its context is

**Status:** Accepted.

## Context

A bot's main session is replaceable working context ([0003](0003-conversation-is-not-session.md)). The server replaced it after 200 turns, a guess made before it could see anything else. That count is blind to what matters: a session of short exchanges was replaced with most of its context still free, losing detail for nothing, and a session of heavy work could fill its context long before 200 turns.

When a context is full, the harness compacts it on its own: it replaces the conversation with a summary it writes, in the middle of the bot's work if that is where the limit falls. The engine also compacts an idle Claude Code thread above 100,000 tokens before its prompt cache expires, which J3 Bots turns on (`idleCompaction`).

The engine reports how full a session's context is. Each provider turn carries its token usage: the tokens of the latest request, the model's window and, where the harness has one and the provider knows it, the point where it compacts (**Read** at `59651c1`). Claude Code's adapter reports the threshold only where a smaller window was set; Codex's reports none.

## Decision

**A main session is replaced once a turn ends with its working context at three quarters of the point where the harness would compact it, or of the model's window where the provider names no such point.**

- The adapter reads the usage of the latest provider turn of each run as it ends and tells it on the turn's end. The server keeps the latest measure on the session; the rotator asks for a `context` rotation from it.
- The rotation happens between turns, never in the middle of the bot's work: like the run limit, it waits until no turn runs or can run and no background work is pending, and the session keeps taking new work until then, so long background work never holds the bot's wakes.
- What a rotation carries forward is unchanged: the digest of the conversation and the bot's memory files.
- **A compaction the harness did on its own does not rotate the session.** It already did what a rotation is for: the context is small again, and its summary keeps more of the working state than a digest does. Rotating after it would throw away a compaction just paid for, and turn every idle hour of a Claude Code bot above 100,000 tokens into a rotation. The session's next measure is low, so it is replaced when it fills again.
- A session whose provider never measured its context keeps the run limit, 200 turns. Every session, measured or not, is replaced after 500: a harness that keeps compacting would otherwise let a session's history, which the engine and the adapter read back after a restart, grow without end.

## Costs

- A quarter of the context is left unused before each rotation, so a session is replaced earlier than the harness would compact it. The margin is what lets the next turn run without reaching the compaction point; one turn that alone fills more than that still meets the harness's compaction.
- The measure is as of the turn's end. A usage the provider reports only after the turn ended counts from the next turn's end, so a rotation can come one turn late.
- The share is a guess, like the run count it replaces ([open question 6](../open-questions.md#6-when-should-a-main-session-rotate-and-what-does-the-digest-contain)).
- A new rotation reason needs a migration of `sessions.rotation_reason`'s check.

## Rejected

**Rotate when the harness compacts.** A compaction already brought the context down, and the engine's idle compaction runs often on idle Claude Code bots: each would cost a compaction and a rotation, with the compaction's summary thrown away.

**Rotate at the compaction point itself.** The measure comes only at a turn's end, and the next turn grows the context before the next measure. At the point itself, the harness would compact in the middle of the next turn nearly every time, which is what rotating between turns avoids.

**Keep counting turns.** It cannot tell a light session from a full one, which is the problem.
