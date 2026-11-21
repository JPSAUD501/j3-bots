# Concepts

These are the words J3 Bots uses in its interface, its prompts, its code and its documentation. Each has one meaning.

## People and bots

**Operator.** The person who runs J3 Bots and owns its bots. There is exactly one. Prompts and the interface call them "the user".

**Bot.** A persistent teammate. A bot has a profile, one conversation with the operator, a memory, a workspace folder, routines, and a model it runs on. A bot is not a chat session: it exists before the first message and after the thousandth.

**Profile.** What makes a bot recognizable: its name, a short title ("Research", "Inbox"), an avatar (a shape and a color), and its **job**, a few sentences in plain language saying what the bot is for and where its limits are. The job is the only per-bot instruction text. Everything else a bot learns goes to memory.

**Primary bot.** The one bot the operator treats as their default contact. New requests that belong to nobody go to it. It may create other bots, hand work to them, and check in on its own. J3 Bots works without one.

**Teammate.** From one bot's point of view, any other bot of the same operator.

## Conversations

**Conversation.** The single ongoing exchange between the operator and one bot. It is what the operator scrolls, searches and reads on every device. J3 Bots stores it. A conversation survives model changes, engine upgrades and session replacement.

**Message.** One entry in a conversation or a room, written by the operator or by a bot. Bot messages are short by design.

**Card.** A structured entry in a conversation that is not prose: a question with options, an approval request, a file, a routine that was created, a handoff between bots.

**Room.** A group chat with the operator and two to six bots. A room has a name, members, a host and its own message history. Bots keep their own memory in a room; they share only what is said there.

**Host.** The bot in a room that answers when the operator addresses nobody in particular, and that decides who should take a request.

## How bots run

**Wake.** Anything that starts a bot turn. There are five kinds:

| Kind | Started by |
| --- | --- |
| `user` | The operator sent a message in the bot's conversation |
| `room` | Something was said in a room and this bot should respond |
| `bot` | A teammate sent this bot a message |
| `routine` | One of the bot's routines came due or its trigger fired |
| `system` | J3 Bots itself has something to tell the bot (it was just created, a background job finished, a setting changed) |

Only a `user` wake carries the operator's instructions. Every other kind is labeled so the bot never mistakes it for the operator typing.

**Turn.** The work a bot does in response to one wake, from the first token to the point where it stops. A turn may deliver zero, one or several messages.

**Session.** The engine thread that holds a bot's working context for the model. A session is an implementation detail: it can be compacted, replaced or lost without the conversation or the bot's identity changing. The operator never sees sessions.

**Engine.** The T3 Code server that J3 Bots runs and drives. It owns model processes, subscriptions, tool execution and approvals.

**Model.** What the bot runs on: a provider instance and a model slug from the engine, such as Claude Code with a specific Claude model. Chosen per bot and changeable.

## What bots keep

**Workspace.** A folder on the host that belongs to one bot. It holds the bot's memory, its skills, and the files it produces. It is a plain directory the operator can open.

**Memory.** Durable facts a bot keeps across sessions, stored as Markdown files in its workspace. Memory has two tiers:

- The **profile note** is small and is in front of the bot on every turn. It holds standing rules and the handful of facts that shape every answer.
- The **log** is dated history. The bot searches it when it needs something older.

**Shared memory.** A short set of facts about the operator that every bot can read: name, time zone, language, a few standing preferences. Any bot may propose an addition.

**Skill.** A reusable procedure a bot can read when a task calls for it: steps, decision rules, what to verify, what needs approval. Skills are files. A skill has no trigger.

**Routine.** A saved instruction plus a trigger. The trigger is a schedule or an inbound webhook. A routine belongs to one bot and runs even when no client is open. A routine's instruction says who receives the result and what to do when there is nothing to report.

## Controls

**Permission mode.** How much a bot may do without asking: supervised, auto-accept edits, auto (an automatic reviewer decides) or full access. This is the engine's runtime mode, set per bot.

**Approval.** A request from a bot to do one specific thing that its permission mode does not allow outright. Only the operator can grant one.

**Question.** A bot asking the operator to choose. It arrives as a card with options, not as prose.

**Budget.** The limits that keep bots from spending the operator's allowance on each other: how many teammates one bot turn may bring in besides those it answers, or one bot's room message may mention, how many hops a chain of bot-to-bot messages may take, how many turns may run at once.

## Names

The product is called **J3 Bots**. Its command is `j3-bots`, its data directory is `~/.j3-bots`, its environment variables start with `J3_`, its desktop app's URL scheme is `j3bots://`, and its packages are in the `@j3-bots/*` scope. J3 Bots is not affiliated with T3 Code or its authors: it runs their server as its engine, unmodified.
