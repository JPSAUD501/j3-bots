# 0095: Little ones a turn handed off stay until they are home

**Status:** Accepted. Amends [0071](0071-a-bot-splits-into-little-ones-under-its-face-and-its-plan-is-a-quiet-card.md): a turn that is over no longer takes the little ones it handed off with it.

## Context

A bot can hand work to its little ones and reply before they finish: "Three of me are going through the repositories; I'll put it all in one report." Its turn ends with that reply. Under [decision 0071](0071-a-bot-splits-into-little-ones-under-its-face-and-its-plan-is-a-quiet-card.md), a turn that is over drew no little ones, so they vanished at the reply, while they went on working. The row folded into "Worked · 5 steps", and nothing said the bot was still at it. The owner saw that and asked why the subagents were no longer shown after the reply, since they had been while the bot delegated.

What the engine says after a turn ends decides what J3 Bots can show:

- **Claude Code.** A background `Agent` call answers at once with an acknowledgement. That answer does not settle the subagent: its item stays running until the harness's `task_notification` for it (**Read** at `bc0f04d`: `ClaudeAdapterV2.ts`, `claudeToolResultSettlesSubagent`, L4605-4615, and the `task_notification` handling, L12480-12576). The item keeps the run that started it. Only a resumed subagent moves to the run that resumed it (`movesToCurrentRun`, L8788-8789).
- **Codex.** A subagent's thread goes on after the parent turn, and is reported complete between turns (**Read** at `bc0f04d`: `CodexAdapterV2.ts`, `hasPendingBackgroundWork`, L8452-8475).
- **The adapter.** For an ended turn, `turn-work` goes on being sent while one of its little ones works, until that one has ended ([Engine](../architecture/engine.md#the-adapters-interface)). The server already kept that on the turn and on its work fold ([Server](../architecture/server.md#a-turns-plan-and-its-little-ones)).

So the data was there. What was missing was J3 Bots' own: clients dismissed the family when the turn ended, and the roster counted only a running turn's little ones.

## Decision

**While little ones a turn handed off still work, its row keeps the bot's face, the line "Working" and the family under it. Each goes home when it ends. Once the last is home, the row folds into its line. The roster keeps a dot for each, whatever the bot does next.**

- **The row.** A turn that has ended with little ones still working keeps the row it had while it ran: the bot's face, then "Working" in place of what the bot was doing, with the chevron to its steps, and the family under the face. The plan folds into its own line as the turn ends, since the plan is done, and the turn's steps read as done, as for any ended turn. The row is the live mark: the bot's face and its little ones keep moving. A dot beside "Worked" would say the turn both ended and still runs. A client knows such a turn from its fold alone, with no new field: its work counts little ones that still work (`littleOnesOut`). A fold still marked running counts the same once the client no longer sees its turn under way, because the roster can tell of the turn's end before the conversation does, and the family must not be dismissed and drawn again in between.
- **Going home.** A little one that ends goes home into the bot, as while the turn ran, and one that failed turns grey first. Once none works, the last stays drawn until it is home, and then the row folds into "Worked · 5 steps" on `slide`, as a turn's row does when it ends. A conversation opened while they work shows them where they are, with nothing played for them.
- **The roster.** Every state but `working` carries the count of little ones the bot's ended turns still have at work (`littleOnes`, an optional field, sent only when there are some), and `working` adds them to its own turn's. The dots stay through the bot's next turn, a question it asks, or a usage limit.
- **Not drawn twice.** A turn the engine starts because a little one reported does not list that little one: the item stays in the run that started it, and only a subagent the bot resumes moves. So the family stays under the turn that handed it off, and the new turn shows only its own.
- **One the engine stops telling of.** The engine counts a live subagent as its turn's pending background work. When its report of the session's background work no longer names a turn, a little one that turn still shows as working has nothing left running it, so it ended untold and is settled as failed. A lost session settles its little ones the same way. This only applies when the report names a turn for every piece of pending work. Work it names no turn for could be that little one.
- **Screen readers** hear how the turn ended once the last little one is home, not as the turn ends.
- **Protocol 11 holds.** The new count is an optional field of the bot's state. An older client reads none and draws no dot after a reply, as before, and it folds the row at the turn's end, as before.

## Costs

- **The line says "Working", not what the little ones do.** Each one's own line is under the face, so a second summary would repeat them.
- **Two faces can move at once.** If the operator writes again while the little ones of an earlier turn still work, the new turn's row runs below the reply with the bot's face, and the earlier row keeps its own until its family is home.
- **A little one the engine never reports again is failed by a guess.** If a report clears its turn of pending work without one last word from the engine, J3 Bots cannot know it finished well. It shows it as "Couldn't finish". The bot's own report, when the wake that ending brings reaches it, says what came of it.
- **Nothing on the row stops them.** There is no control to stop one little one, nor the family; what Stop reaches is as before.

## Rejected

- **A dot beside the folded line ("• Worked · 5 steps") and the little ones under it.** The family needs the face it comes out of and goes home to. A face that appears for them and goes with them reads as the turn coming back.
- **Holding the turn open on the server until its little ones end.** The turn has ended, and the bot answered. A turn held open would read as a turn under way everywhere else: the composer, Stop, the roster's state line, the routine that waits on it.
- **A new bot state for "its little ones work".** The bot itself is free to take the next message. Only the count of its little ones changes, which every state can carry.
