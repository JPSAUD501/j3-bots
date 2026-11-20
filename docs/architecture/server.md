# Server

The J3 Bots server is the product. It owns what the operator sees and decides what every bot does next. This document describes its data, its one central mechanism (the wake pipeline) and the features built on it.

## Data

J3 Bots keeps two kinds of state, in two places, for two different readers.

**The database** (`<J3_HOME>/j3.sqlite`) holds what the server needs to query and what clients render:

| Entity | What it holds |
| --- | --- |
| Bot | Profile, model, permission mode, workspace path, engine project id, current main session |
| Conversation | One per bot. A sequence of entries |
| Room | Name, members, host, budget. A sequence of entries |
| Entry | A message or a card, with author, time, and delivery state |
| Session | An engine thread id, its bot, its purpose (main or side), its run count and when it was created |
| Wake | Kind, target bot, payload, status, attempts, the engine command id, the outcome |
| Routine | Bot, name, instruction, trigger, enabled, next run, recent runs |
| Device | A paired client: its token hash, its push token, its notification preferences |

**The filesystem** (`<J3_HOME>/bots/<bot>/`) holds what a bot reads and writes with its own tools, and what the operator may want to open in an editor:

```
bots/scout/
  .j3/
    system.md        generated: base prompt + profile + pinned memory
  AGENTS.md          generated: the same identity for harnesses that read it
  memory/
    profile.md       small, always in front of the bot
    log/2026-11.md   dated history
  skills/            procedures, one folder each
  files/             what the bot produces
shared/
  user.md            facts about the operator every bot can read
  skills/            skills available to every bot
```

Generated files are written by the server from the database and the memory files. A bot never edits them by hand, and the server rewrites them whenever their inputs change.

Memory lives in files and not in the database because the bot's own tools can read, search and quote files, and because the operator can read, edit, diff and back them up without J3 Bots. See [decision 0006](../decisions/0006-memory-is-files.md).

## The wake pipeline

Everything a bot does starts as a **wake**. There is one pipeline for all five kinds, and it is the only path to the engine.

```
 operator message ─┐
 room message ─────┤
 teammate message ─┼──> wake (persisted) ──> dispatcher ──> engine session ──> turn
 routine trigger ──┤                             │
 system event ─────┘                             └── budgets, ordering, concurrency
```

### 1. A wake is recorded before anything happens

Creating a wake and the entry that caused it (the operator's message, the room message) is one transaction. A wake that exists will be dispatched; one that does not exist never was requested. If the server stops between recording and dispatching, it picks the wake up again at start.

### 2. The dispatcher decides whether and when

For each pending wake the dispatcher applies, in order:

- **Budget.** A wake caused by a bot carries a hop count. If the chain that led here exceeds the limit, the wake is dropped and the conversation or room shows that the chain stopped. See [Budgets](#budgets).
- **Coalescing.** Several pending wakes of the same kind for the same bot become one dispatch: three room messages that arrived while the bot was busy are delivered together.
- **Concurrency.** At most N turns run at once across all bots. Operator wakes go first.
- **Blocked providers.** If the bot's provider is at its usage limit, routine and bot wakes wait for the reset. An operator wake is dispatched anyway so the operator gets the engine's own limit message.

### 3. Dispatch is idempotent

The dispatcher sends one `message.dispatch` command to the engine with the wake id as the command id. Sending it twice has no effect the second time.

How the message is delivered depends on the kind:

| Wake | If the bot is idle | If the bot is mid-turn |
| --- | --- | --- |
| `user` | Start a turn | If the operator opened the running turn, steer it, so they can redirect work in progress. Otherwise queue at the front, so a private message never lands in a room turn |
| `room`, `bot`, `system` | Start a turn | Queue behind the running turn |
| `routine` | Start a turn in a side session | Unaffected: side sessions run alongside |

### 4. The turn is observed, not trusted

The adapter streams the session's events and the server derives the bot's state from them: thinking, working, waiting on a request, blocked, finished. The operator's clients see that state live.

What the bot *says* does not come from that stream. It comes from the bot calling J3 Bots' `say` tool, which appends an entry and returns. A `say` with `done: true` closes the delivery: once the call has returned, the server interrupts the run, so the model cannot keep spending allowance after its answer. Delegated tasks are separate engine threads and keep running.

The turn's final reply text is never published: the base prompt tells the bot it reaches nobody, and the bot may have used it for notes. If a `user` wake's turn ends without a `say` carrying `done: true`, a pending question or a background handoff, the server wakes the bot once more with an `undelivered` system wake. If that turn also delivers nothing, the conversation shows a notice with a retry action.

### 5. The outcome closes the wake

When the turn ends, the wake records how: completed, failed (with the engine's error class), interrupted, or waiting on the operator. A failed routine wake is retried according to its routine's policy; a failed operator wake is shown in the conversation with a retry action.

## Sessions

Each bot has one **main session**: an engine thread in the bot's project, where operator turns, room turns and teammate messages all land. One working context means a bot in a room can use what the operator told it privately, which is what makes it the same teammate everywhere.

**Side sessions** are short-lived engine threads in the same project, used for routine runs. They start with fresh context, see the same system prompt and memory files, and can deliver messages with `say` like the main session.

Because the main session does not see what a side session did, the server keeps a short **catch-up note** per bot. When the bot next wakes in its main session, the envelope begins with what happened since: "Routine 'Morning repo check' ran at 08:03 and told the user: …".

**Rotation.** The server replaces a bot's main session when any of these is true: it passed a threshold of runs, the engine reports a provider-side failure to resume, the operator changed the bot's provider, or the operator asked for a fresh start. The new session's first envelope carries a digest of the recent conversation. The conversation itself is untouched.

## Bot tools

Bots act on J3 Bots through a small MCP server named `j3`. The harness starts it as a local stdio process; that process forwards each call to the J3 Bots server over loopback.

The bridge identifies its caller from `T3CODE_THREAD_ID`, an environment variable the engine sets for the Claude Code process and for each stdio MCP server Codex starts. The server maps that thread id to a session and a bot. A call from an unknown thread is refused. **Read** in the engine source; to be verified end to end.

| Tool | Purpose |
| --- | --- |
| `say` | Deliver a message to the operator, or to the room during a room turn. Optional attachments. Marks whether the turn is finished. |
| `ask` | Put one question to the operator as a card with options. Ends the turn. |
| `message_bot` | Send a message to a teammate. `urgent` wakes them now; otherwise it waits for their next turn. Returns only a delivery acknowledgement. |
| `remember`, `forget`, `recall` | Write, remove and search memory, in the bot's own scope or the shared one. |
| `set_routine` | Create, change, pause, resume or delete one of the bot's routines. |
| `list_teammates` | Names, titles and jobs of the operator's other bots and the rooms this bot is in. |
| `create_bot`, `update_bot` | Primary bot only by default: create a teammate with a name and a job, or refine one. |
| `update_profile` | Change this bot's own name, title or avatar when the operator asks. |

The complete parameter schemas and the wording of each description are part of the prompt package. See [Prompt architecture](../prompts/architecture.md#tools).

## Rooms

A room is J3 Bots data: members, host, entries. There is no engine object behind it.

When an entry is added to a room, the server decides who wakes:

| The entry | Who wakes |
| --- | --- |
| From the operator, mentions one bot | That bot |
| From the operator, mentions `@everyone` | Every member, one at a time in member order; each sees the replies before it |
| From the operator, mentions nobody | The host |
| From a bot, mentions another bot | The mentioned bot |
| From a bot, mentions nobody | Nobody. The room waits |

A room wake is delivered into the bot's **main session**, wrapped in an envelope that names the room and carries only the entries the bot has not yet seen. During that turn `say` delivers to the room, and `say` with `to: "dm"` delivers privately to the operator.

A bot that has nothing to add ends its turn without calling `say`. That is the normal way a room goes quiet.

Approvals and questions raised during a room turn appear in the bot's own conversation. The room shows the bot as waiting.

## Teammate messages

`message_bot` appends a handoff card to the sender's conversation and creates a `bot` wake for the recipient.

- **Urgent** messages wake the recipient now.
- **Non-urgent** messages are held and delivered at the top of the recipient's next envelope, whenever that is.
- The sender gets an acknowledgement, never a reply. A reply is a separate `message_bot` call from the other side and arrives as a new wake.

The prompt tells bots not to acknowledge acknowledgements. The hop budget enforces it.

## Routines

A routine is a row with an instruction and a trigger. The server's scheduler owns it; the engine's scheduled tasks are not used.

- **Schedule triggers** are five-field cron expressions evaluated in the operator's time zone, with a five-minute minimum spacing.
- **Webhook triggers** are an HTTP endpoint on the J3 Bots server with a secret in the path and an optional HMAC signature. The request body reaches the bot as data inside a nonce-tagged block.
- A run that comes due while the previous run of the same routine is still going is skipped and recorded as skipped.
- Runs missed while the server was down are not replayed, except that each routine runs once on return if it missed at least one.
- A routine run ends in one of three ways: it said something (`say`), it finished silently with a result recorded in its history, or it failed.

Each routine keeps its recent runs with status, duration and what was delivered.

## Budgets

Three limits keep bots from spending the operator's allowance on each other. All three have conservative defaults and are settings.

| Limit | Default | Applies to |
| --- | --- | --- |
| Hops | 4 | Consecutive bot-caused wakes in one chain since the operator last spoke |
| Fan-out | 1 | Bots a single bot message may wake, unless the operator asked for more |
| Concurrent turns | 2 | Turns running at once across all bots |

When a limit stops something, the place where it stopped says so in one quiet line. Nothing is dropped silently.

## Notifications

The server sends a notification when an entry is added to a conversation or room and no connected client currently has it in view, and when a bot starts waiting on the operator.

- **Web and desktop**: over the open connection, shown by the client.
- **Mobile**: a push through the platform's service. The payload carries the bot's name and, if the operator allows it, the first line of the message. See [open question 5](../open-questions.md).

Routines that end silently and non-urgent teammate messages never notify.

## Client API

Clients use one WebSocket to the server, with typed requests and subscriptions defined in `packages/contracts`.

- **Subscriptions** send a snapshot and then changes, with a sequence number for resuming: the roster (every bot and room with its state and last entry), one conversation or room at a time, routines, engine status.
- **Commands** carry a client-generated id and are idempotent: send a message, answer a card, stop a bot, create or change a bot, a room or a routine, edit memory.
- The server pages history; a client asks for older entries as the operator scrolls.

A client that reconnects resumes each subscription from its last sequence number or receives a fresh snapshot.

## Failure handling

| Failure | What the server does |
| --- | --- |
| The engine process exits | Restarts it, reconnects, resumes subscriptions, resumes held queues, re-dispatches wakes that were recorded but not acknowledged |
| The engine socket drops | Reconnects with backoff and resumes each subscription by sequence |
| A turn fails | Records the engine's error class on the wake and shows it; retries only routine wakes, with a cap |
| A provider hits its limit | Marks the provider's bots blocked with the reset time; holds automated wakes until then |
| The server process exits | On start, loads pending wakes and continues. No turn is started twice because dispatch is idempotent |
| A session cannot be resumed | Rotates to a new session seeded from memory and the recent conversation |
