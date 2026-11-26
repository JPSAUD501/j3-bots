# 0070: A turn's plan and its little ones are its work, shown only to its audience

**Status:** Accepted.

## Context

The harnesses keep a plan as they work: Claude Code writes a todo list, and Codex updates its plan. They also start subagents that work beside the bot, and the engine can run a task the bot delegates. Before 0.11.0, J3 Bots showed each of these as one more work step: "Updated its plan" every time the list changed, and a step for each subagent launch, worded like any other tool. The plan itself was never visible. A subagent was a launch line with nothing after it: no word of whether it still ran, how many ran at once, or how it ended.

The owner wants to see the plan while a turn runs, and to see the bot's parallel work as part of the bot: little copies of it that split off, work, and come back. The engine already records both. Each plan update writes a `todo_list` item into the turn's run, and each subagent and delegated task writes a `subagent` item, nested ones included ([Engine](../architecture/engine.md#the-adapters-interface), **Read** at `59651c1`).

## Decision

**A turn's plan and its little ones are the turn's work: data of their own, not steps, sent only to the turn's audience.**

- **The plan is the run's latest todo list,** told whole each time it changes. A newer plan replaces it; a turn that ended keeps its last one. Its steps carry their text and whether each is to do, under way or done. The contract caps it at 100 steps of 300 characters.
- **A little one is a subagent or a delegated task.** It carries a few words of what it does, its state (working, done, or failed, which includes stopped), when it started and ended, and progress while it works, when the engine reports any. The few words come from Claude Code's own short description of the subagent, else from the first words of its instructions, at most eight, so instructions of a few words are their own label. When neither exists the label is null, and the client words that case. A little one never carries its instructions whole, its result, or a name: the bot reports the result itself, in its own words. Claude Code's nested subagents are flattened into the turn's list; a Codex subagent's own are not shown (Costs). A turn's work names at most 16 and counts all of them, so a client that draws four can say "+N".
- **Only the turn's audience sees it.** A private turn's work goes on its work fold (`WorkFoldEntry.work`), so a reopened conversation shows each turn's last plan. A room turn's work goes on the room, by the member whose turn it is (`Room.memberWork`), while that work runs. It is never on the member's own fold. A routine's turn shows none. The server keeps each turn's work with the turn, so a restart serves the same thing.
- **The steps it replaces go.** "Updated its plan", and the launch step for a subagent or a delegated task, are no longer written. Steps already stored keep their words.
- **A little one handed off past the turn's end is still told** until it ends. If its session is lost, it is marked failed.
- **Protocol 11 holds.** Every field is optional to a client. One that predates them drops them and shows the turn's other steps. A newer client reads them as none from an older server. A plan step's status and a little one's status are open sets.

## Costs

- **An older client loses the plan step and gets nothing in its place.** That is a quieter conversation, not an error. A protocol bump to tell it to update was not worth locking every older client out.
- **A room's plan is gone from the room once the room's work ends.** The room shows what runs now, as its answering members do. The turn keeps its work, and the bot's reply says what was done.
- **A turn with a very long plan or many little ones** is cut and counted, not shown whole. A plan past 100 steps is not one a person reads anyway.
- **Labels depend on the harness.** Claude Code gives a short description. Codex and the engine's delegated tasks give only instructions, from which J3 Bots takes the first few words. That is less apt than a description, but never the whole text. A Codex subagent's title is its agent path, a name, and is never used.
- **A Codex subagent's own subagents are not shown.** The engine records them in that subagent's thread, which J3 Bots does not follow. Following it would add a stream per subagent for a rare case. Claude Code's nested subagents are in the turn's run, and are flattened into its list.

## Rejected

- **Keep the plan as a step whose text is the checklist.** A step is a line in a fold the operator opens. A plan has to stay visible while the turn runs, and replace itself rather than pile up.
- **A new kind of entry for the plan.** A client before it would show "This needs a newer version of the app" for every turn that kept a plan.
- **A new subscription for a turn's work.** Within protocol 11, a newer client calling it on an older server would fail. The fold and the room already reach the right audience, live and on reconnect.
- **Put a room turn's plan on the member's fold.** The fold lives in the member's own conversation, so the room's plan would show to the wrong audience and never in the room.
- **Show a little one's result, or let it speak.** The result is the bot's to tell, in its own words and to its audience. A little one that spoke would be a second voice the operator never asked for.
- **Name each little one.** They are the bot's copies, not teammates. A name would make them look like bots of their own.
