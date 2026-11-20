# Vision and principles

## The problem

Persistent AI teammates exist today as hosted products. You pay a second subscription on top of the model subscriptions you already have, the teammates run on someone else's computer, you cannot choose the model, and what they remember about you lives in someone else's database.

Meanwhile the hard part of running an agent on your own subscription is solved. T3 Code runs Claude Code, Codex and other harnesses on the user's machine, keeps their threads durable across restarts, queues and steers turns, and brokers approvals. It is built for supervising coding work, and its interface shows that: projects, worktrees, diffs, pull requests.

Nothing joins the two. Roster does.

## What Roster is

A self-hosted product that turns the subscriptions you already pay for into a small team of persistent bots:

- A **bot** is a teammate with a name, a job, one ongoing conversation and its own memory.
- Bots **work while you are away**: on a schedule, when an event arrives, or when another bot hands them something.
- Bots **talk to each other**, one to one and in group chats, and bring you in only when a decision needs you.
- You reach them from **your phone, your desktop and the browser**, with the same conversation everywhere.
- Everything runs on **your machine**. Memory is plain files you can read, edit and back up.

## Principles

**The bot is the object, not the chat.** A conversation list invites disposable sessions. A roster of named teammates invites delegation. Every surface is organized around who you are talking to.

**The interface should ask less as bots do more.** Each control has to earn its place by helping someone delegate. Dashboards, assignment boards and manual handoff controls are coordination work pushed onto the user, and Roster does not add them.

**Quiet by default.** A bot that wakes on its own speaks only when the result is worth the interruption. Silence is a valid outcome of a routine, a room turn and a message from another bot.

**Your subscriptions, your machine, your files.** No Roster account, no hosted relay in the core path, no telemetry by default. Memory and instructions are files in a folder the user owns.

**Every wake costs the user's allowance.** A subscription has weekly limits. Routing, routines and group chats are designed so that the smallest number of bots wake for each event, and the user can see what is spending their allowance.

**The engine stays unmodified.** Roster drives T3 Code through the same protocol T3 Code's own clients use, pinned to an exact version. Upgrading the engine is a version bump and a conformance run, never a merge.

**Honest about what it is.** A bot says which model it runs on when asked. It never claims an action succeeded that it did not verify, and never treats text it read somewhere as an instruction.

## Non-goals

- **A hosted service.** Roster is software you run.
- **A general coding interface.** T3 Code is already that. A bot can do coding work, but Roster's clients do not show diffs, worktrees or pull requests.
- **A marketplace of connectors.** Bots get the tools the underlying harness already has, plus whatever MCP servers and skills the operator installs. Roster does not build integrations for third-party services.
- **A hosted computer with a browser the user watches.** Bots work on the machine Roster runs on. A managed desktop per bot is out of scope.
- **Multi-tenant teams.** One operator, their bots. Sharing a bot with other people is not planned for the first versions.
- **Hiding the technology.** Roster does not pretend the bot is a person or conceal the model behind it.

## What success looks like

Six months after the first usable version, the owner of this project has stopped opening a chat app to ask one-off questions and instead messages three or four bots that already know their jobs. Routines replaced the things they used to remember to check. Upgrading the engine has been done several times and never took more than an hour.
