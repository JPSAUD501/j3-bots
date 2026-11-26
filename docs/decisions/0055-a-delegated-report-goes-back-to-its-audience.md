# 0055: A delegated task's report goes back to the audience that delegated it

**Status:** Accepted. Extends [0013](0013-background-work-belongs-to-the-turn-that-started-it.md).

## Context

[Decision 0013](0013-background-work-belongs-to-the-turn-that-started-it.md) makes background work part of the turn that started it: the turn its completion starts speaks to that turn's audience, and counts with it for hops and Stops. That holds when the completion starts a turn of its own. The engine does that only when no turn of the session runs. A completion, or a notice of the task such as its question, that arrives while any turn runs is steered into that turn, whichever turn delegated the task (**Read** at T3 Code `59651c1`, `Orchestrator.ts`, L7631-7673). Since T3 Code `0.1.11` Claude Code sessions do this too, as Codex sessions already did.

A bot works for several audiences in one main session: its own conversation and each room it is in. So a room's result can reach the bot in a private turn, which cannot speak in the room, and a private result can reach it in a room turn, whose words go to the room. The engine's steer is not something J3 Bots can turn off for J3 Bots' bots alone: the per-task setting that holds a completion back (`completionWake: "settled_only"`) holds it while the delegating turn runs too, and a result can then go unread.

## Decision

**The adapter tells J3 Bots of each report steered into a turn other than the one that delegated the task, and the server brings it to the delegating turn's audience as a wake of that audience.**

- The adapter knows the delegating run: a completion names it, and a notice names the task, whose item is in that run. It tells the report once, by the engine's message id, with the turn it landed in, the delegating turn and the text, and lists it again in a replacement after a gap (`delegated-result`, [Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)).
- When the turn it landed in is for another audience, the server records a `system` wake, `delegated-result`, for the delegating turn's audience, once per report. Its cause is the delegating turn's work, so a Stop that covers that work drops it, and a Stop of the audience cancels it as any wake there.
- The turn it starts records the delegating turn as the one whose work it continues: it speaks to that audience, and counts with that turn for hops and Stops, as 0013 says.
- The bot is told, in its base prompt and in the wake's envelope, that a delegated task's result is handled in the conversation it was delegated from.

## Costs

- The report reaches the unrelated turn all the same, and the model has read it there. J3 Bots cannot unread it; the bot is told to leave it for its own conversation, and a bot that answers it there anyway answers twice.
- One more turn per report that lands elsewhere, with the report in its envelope.
- A report whose delegating turn the server never admitted, such as one from before J3 Bots followed the session, has no audience to go to and is not brought back.

## Rejected

- **Telling the bot in the unrelated turn whose work it is,** and letting it speak to the other audience from there. A turn speaks only to its own audience, which is how a Stop of a room can end everything the room asked for; a turn that speaks to two audiences would make every Stop and budget rule ask which.
- **Holding completions back (`settled_only`) for every task a bot delegates.** The engine holds a completion so until the delegating turn has settled, then may not offer it while other turns run, and a result can be lost (**Read** at `59651c1`).
- **Leaving it to the engine.** J3 Bots does not modify the engine ([0001](0001-t3-code-as-unmodified-engine.md)), and every later stable release carries the change.
