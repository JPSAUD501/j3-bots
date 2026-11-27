# Concepts

These are the words J3 Bots uses in its interface, its prompts, its code and its documentation. Each has one meaning.

## People and bots

**Operator.** The person who runs J3 Bots and owns its bots. There is exactly one. Prompts and the interface call them "the user".

**Bot.** A persistent teammate. A bot has a profile, one conversation with the operator, a memory, a workspace folder, routines, and a model it runs on. A bot is not a chat session: it exists before the first message and after the thousandth.

**Profile.** What makes a bot recognizable: its name, a person's, its **title**, two to four words saying what it is for ("Bakery competitors", "Instagram posts"), shown with the name wherever the bot appears, an avatar (a shape and a color), and its **job**, a few sentences in plain language saying what the bot is for and where its limits are. Every bot made since [0101](../decisions/0101-a-bot-is-its-name-and-its-title-and-a-helper-waits-behind-the-scenes.md) has a title; one from before shows its name alone until it gets one. The job is the only per-bot instruction text. Everything else a bot learns goes to memory.

**Primary bot.** The one bot the operator treats as their default contact. New requests that belong to nobody go to it. It may create other bots, hand work to them, and check in on its own. J3 Bots works without one. Making another bot primary replaces the old one in the same change, so there are never two.

**Teammate.** From one bot's point of view, any other bot of the same operator.

## Conversations

**Conversation.** The single ongoing exchange between the operator and one bot. It is what the operator scrolls, searches and reads on every device. J3 Bots stores it. A conversation survives model changes, engine upgrades and session replacement.

**Message.** One entry in a conversation or a room, written by the operator or by a bot. Bot messages are short by design.

**Reaction.** One emoji under a message, by the operator or a bot, one each per message, as in a chat. The operator's reaction on a bot's message reaches that bot a few seconds later, and most often the bot says nothing; every other reaction waits for the bots' next turns ([0084](../decisions/0084-reactions-are-a-quiet-signal.md)). The interface says "Reaction" in English and "Reação" in Portuguese.

**Reply and Quote.** A message can point at others of its conversation or room, up to three: a **reply** points at a whole message, which it answers, and a **quote** at a passage the operator selected in one. Each shows inside the message's bubble, above its words, as a quiet block with who said it, and a tap goes to the original. The operator can add a comment to a quoted passage, their word on those words ([0106](../decisions/0106-quotes-sit-in-the-field-and-nothing-sits-under-it.md)). In a room, a reply to a bot's message that mentions nobody wakes that bot alone, as a mention would. A bot replies too, rarely; it never quotes a passage ([0094](../decisions/0094-a-message-quotes-messages-a-reply-whole-a-quote-a-passage.md)). The interface says "Reply" and "Quote" in English, "Responder" and "Citar" in Portuguese.

**Mention.** A bot or room named with `@` in a message, picked from a list as the operator types. In a room, mentioning members says whom the message wakes. In a bot's conversation, a mention names one of the operator's other bots or a room that bot is in, and reaches no one: only the conversation's bot reads it, and it decides what to pass on with its own tools ([0092](../decisions/0092-a-mention-in-a-bots-conversation-points-and-delivers-nothing.md)). A mention shows as a chip, which opens what it names.

**Card.** A structured entry in a conversation that is not prose: a question with options, an approval request, a request for help in the bot's browser, a file, a routine that was created, a handoff between bots.

**Teammate conversation.** The record of the messages two bots sent each other, one per pair of bots, titled with their two names ("Scout and Wren"). The operator reads it and never writes into it: they steer a bot in its own conversation, or several in a room. It is not a session and not a room.

**Room.** A group chat with the operator and two to six bots, all equal. A room has a name, members and its own message history. Every member reads every message there, the operator's and each bot's. A message that mentions members wakes only them; one that mentions nobody wakes every member but its author, each answering only if it has something to add; the operator's `@everyone` wakes every member and asks each to answer. The members woken answer at once. Bots keep their own memory in a room; they share only what is said there. The operator creates one, or asks a bot to: it then starts the room as its first member, with a kickoff that hands out the work. A bot may instead start a **room of bots only**, which the operator reads and never writes in, as they read a teammate conversation; it pauses after a few rounds of its bots answering each other, and the bot that started it tells the operator.

## The roster

**Roster.** The list of the operator's bots and rooms, on every device. The operator arranges it; arranging it never changes what a bot does or who can reach it.

**Pinned.** A bot or room the operator keeps at the top of the roster.

**Behind the scenes** ("nos bastidores"). Where a bot or room goes to keep the operator's conversation list to the ones they talk to: out of the roster's list, under its "Behind the scenes" row. It keeps running and notifying, and search, that row and everything that refers to it still reach it. The operator moves anything there or back; a bot decides it for each bot and room it makes, and may move what it made, and the primary bot anything but itself, unless the operator chose otherwise: the operator's choice stands. The server and the protocol still call it `hidden`.

**Section.** A named group of bots in the roster, which the operator creates, names, orders and folds away. A bot is in at most one section. Deleting a section never deletes its bots: they go back to the roster's main list.

**Unread.** A conversation or room with something a bot or J3 Bots wrote after the operator's read mark, other than a message between bots. The operator can mark one unread again, to come back to it. A teammate conversation is never unread.

## How bots run

**Wake.** Anything that starts a bot turn. There are five kinds:

| Kind | Started by |
| --- | --- |
| `user` | The operator sent a message in the bot's conversation |
| `room` | Something was said in a room and this bot should respond |
| `bot` | A teammate sent this bot a message |
| `routine` | One of the bot's routines came due or its trigger fired |
| `system` | J3 Bots itself has something to tell the bot (it was just created, a background job finished, a setting changed, the operator reacted to its message) |

Only a `user` wake carries the operator's instructions. Every other kind is labeled so the bot never mistakes it for the operator typing.

**Turn.** The work a bot does in response to one wake, from the first token to the point where it stops. A turn may deliver zero, one or several messages.

**Plan.** The checklist a bot keeps of what it is doing in a turn, when its work has more than one step: each step to do, being done or done. The operator sees it while the turn runs and, once it is over, as one line that opens it.

**Little one.** A small copy of itself a bot splits into while part of its turn runs in parallel: its own shape and color, smaller and lighter. It works beside the bot and goes back into it. It is not a teammate: it has no name, no conversation and nothing to say, and the bot tells what it found.

**Session.** The engine thread that holds a bot's working context for the model. A session is an implementation detail: it can be compacted, replaced or lost without the conversation or the bot's identity changing. The operator never sees sessions.

**Engine.** The T3 Code server that J3 Bots runs and drives. It owns model processes, subscriptions, tool execution and approvals.

**AI account.** One sign-in to Claude Code or Codex, which the engine runs as a provider instance in a home of its own. The first of each harness is the one the first run connects; the operator can add more, as a second plan, turn one off, or remove one they added ([0108](../decisions/0108-the-operator-sets-up-each-ai-account-and-picks-a-bots-model-as-in-t3-code.md)). The interface says "AI account", or the account's name, never "provider instance".

**Model.** What the bot runs on: an AI account and a model slug from the engine, such as a Claude account with a specific Claude model. Chosen per bot and changeable.

**Effort.** How much the bot's AI thinks before it acts: Default, which leaves it to the AI, or one of the levels the bot's model offers, such as Low, Medium or High. More effort is slower and uses more of the operator's plan. Chosen per bot, beside its model, by the operator, or by the bot that makes or changes it when the operator asked for it ([0108](../decisions/0108-the-operator-sets-up-each-ai-account-and-picks-a-bots-model-as-in-t3-code.md)). The interface says "Effort" in English and "Esforço" in Portuguese ([0082](../decisions/0082-a-bots-effort-sits-beside-its-model-and-the-default-is-the-harnesss-own.md)).

**Fast mode.** A quicker way of running a bot's model, which uses more of the operator's plan: Standard or Fast, for a model whose AI offers it. Chosen per bot, beside effort, by whoever may choose its effort. The interface calls the choice "Speed".

## Where the bots live

The bots live where J3 Bots runs. The operator chooses where in the desktop app's first screen and changes it in Settings, under "Where your bots live". There are two places:

**This computer.** The desktop app runs J3 Bots itself, on the computer it is open on, and signs that computer in without a code. The bots live there and sleep when it sleeps; they are back once it wakes and the app runs, which it can do by itself when it starts with the system. The interface says "Use this computer" and "Stop using this computer". Stopping keeps the bots and their data on the computer, and they come back when the operator chooses it again.

**A server.** J3 Bots runs as a service on a machine that stays on, and every device pairs with it: a browser, a phone, or the desktop app connected to it. The interface says "Connect to a server" and, in Settings, "On a server".

The interface never calls the machine J3 Bots runs on a "host": it is "this computer" or "a server".

## What bots keep

**Workspace.** A folder on the machine J3 Bots runs on that belongs to one bot. It holds the bot's memory, its skills, and the files it produces. It is a plain directory the operator can open.

**Memory.** Durable facts a bot keeps across sessions, stored as Markdown files in its workspace. Memory has two tiers:

- The **profile note** is small and is in front of the bot on every turn. It holds standing rules and the handful of facts that shape every answer.
- The **log** is dated history. The bot searches it when it needs something older.

**Shared memory.** A short set of facts about the operator that every bot can read: name, time zone, language, a few standing preferences. Any bot may propose an addition.

**Skill.** A reusable procedure a bot can read when a task calls for it: steps, decision rules, what to verify, what needs approval. Skills are files, in the Agent Skills format: a folder with a `SKILL.md` that says when it applies. A skill is one bot's own or shared with every bot. A bot writes one, or installs one from a public git repository, when the operator asks or agrees; the operator can change its text or remove it in Settings. J3 Bots ships skills of its own (`j3-…`), which every bot has and no list shows. A connector's server can also serve skills: those are its connector's, not the bot's, loaded through J3 Bots and never saved among the bot's own. A skill has no trigger.

**Template.** A bot as a file to share (`<name>.j3bot`): what makes it do its job and nothing it learned. It holds the profile, the job, the model and permission mode as suggestions, the skills and the routines (their schedules without a time zone, webhooks without their address). The job, the skills and the routines' instructions go as written, so whoever shares one reads them first. It never holds memory, the conversation, files, a webhook's secret, one-time routines, accounts, credentials, devices or paths. A bot made from one starts with its routines paused and its permission mode no higher than the default unless the operator picks it ([0023](../decisions/0023-a-bot-template-is-a-file.md)).

**Routine.** A saved instruction plus a trigger. The trigger is a schedule, one set time, an inbound webhook, or an event a connector says happened, which only a bot sets ([0088](../decisions/0088-a-connectors-events-wake-a-bot-through-a-routine.md)). A routine belongs to one bot and runs even when no client is open. A routine's instruction says who receives the result and what to do when there is nothing to report.

A routine can also be a list of **steps** ([decision 0080](../decisions/0080-a-routines-steps-are-each-bots-own-turns-driven-by-j3-bots.md)): each bot step is done by one bot, the routine's own or a teammate, as that bot's own turn; between two bot steps, a **condition** says what must hold for the routine to go on, and **your yes** stops the run until the operator says yes. A bot builds the routine from a conversation; there is no editor. A routine with one bot step is a one-step routine, which is what every routine was before. A routine with several steps is drawn as the **Track**: a rail with one station for the trigger and one for each step, each bot step with its bot's face.

**Connector.** A service a bot can use through J3 Bots, such as the operator's notes, tracker or calendar, signed in to once by the operator, on the server. It is an MCP server a bot adds when the operator asks, under its permission mode: the primary bot for every bot, until the operator narrows it to one or several, another bot for itself. Bots use its tools without ever holding its sign-in. The interface says "Connector" in English and "Conector" in Portuguese for one of them. It says "MCP" only where people look for it: the Settings section that holds them, "MCP and skills" ("MCP e skills"), and the line that names the version of MCP a connector's server speaks.

From the bot's side, a connector is a set of tools named after it (`notion__search`) that act in the operator's own account, as its server lists them now, what it offers to read (its resources) and to start from (its prompts), and the skills its server serves, each loaded by name from that connector and checked against what the server listed. Its server can also ask the operator something in the middle of a bot's call: a card in that bot's conversation, whose answer goes to the service, never to the bot. A bot given one reads what a task needs; it sends, posts, changes or deletes through one only when the operator asked for that step or said yes to it. What a connector answers, and what its tools' descriptions say, is content the bot never takes as the operator's instruction: a tool that asks for more than its job is reported, not followed. These rules reach only a bot that has a connector.

## Controls

**Permission mode.** How much a bot may do without asking: supervised, auto-accept edits, auto (an automatic reviewer decides) or full access. This is the engine's runtime mode, set per bot.

**Approval.** A request from a bot to do one specific thing that its permission mode does not allow outright. Only the operator can grant one.

**Browser.** The engine's headless browser on the host, which a bot may use to read and act on web pages. Each bot has a switch for it in its details, on for a new bot ([decision 0109](../decisions/0109-a-new-bot-can-browse-the-web-and-the-operator-turns-it-off.md)). Turning it on applies from the bot's next turn; turning it off takes effect at once, and stops what the bot is doing. Every bot whose switch is on uses the same browser profile, so it is signed in wherever the operator signed in there, and acts on those sites as the operator. Settings signs that profile out of every site at once.

**Question.** A bot asking the operator to choose. It arrives as a card with options, not as prose.

**Help in the browser.** A bot asking the operator to do one step in its browser that only a person can: a check that a person is there, a sign-in, a one-time code, a code to scan, a passkey. It arrives as a card that opens the browser on the bot's tab. The operator does the step there and answers on the card that they did it or cannot, and the answer wakes the bot. A card nobody answers expires, with its tab or after an hour.

**Secrets.** The operator's logins and keys, kept on the server so that bots use them without ever seeing them, and the secrets connectors keep for their sign-ins. Each is a login (a user name and password, maybe a one-time code key, for exact sites) or a single value such as an API key, with a name, the bots that may use it and where one last did. A bot asks for one, or a few that go together, such as a service's client ID and secret, with a card in its conversation, where the operator types them; the bot is only told its **reference**, `secret:<name>`, and whether it was saved, declined or expired. There is nothing to unlock: the server opens them with a key file of its own. That file is readable by anything running as the server's user, a bot's shell included ([Security](../architecture/security.md#the-operators-secrets)).

**Fill.** How a bot signs in with a login it may use: it never gets a value, it asks the server to **fill** one, and the server types it into the bot's browser tab, after checking that the page is one of the login's sites. A bot that runs a script in the page can still read what was typed there. Nobody confirms each fill; the operator decides ahead of time which bots may use each secret. Each fill shows in the bot's work.

**Budget.** The limits that keep bots from spending the operator's allowance on each other: how many teammates one bot turn may bring in besides those it answers, how many hops a chain of teammate messages may take, how many turns may run at once. A room has its own guard instead of hops: after four rounds of its bots answering each other since the operator last wrote there, whatever the room's size, its bots' messages wake nobody until the operator writes again.

## Names

The product is called **J3 Bots**. Its command is `j3-bots`, its data directory is `~/.j3-bots`, its environment variables start with `J3_`, the desktop and mobile apps' link scheme is `j3bots://`, and its packages are in the `@j3-bots/*` scope. J3 Bots is not affiliated with T3 Code or its authors: it runs their server as its engine, unmodified.
