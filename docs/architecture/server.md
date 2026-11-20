# Server

The J3 Bots server is the product. It owns what the operator sees and decides what every bot does next. This document describes its data, its one central mechanism (the wake pipeline) and the features built on it.

## Data

J3 Bots keeps two kinds of state, in two places, for two different readers.

**The database** (`<J3_HOME>/j3.sqlite`) holds what the server needs to query and what clients render:

| Entity | What it holds |
| --- | --- |
| Settings | One row: the operator's time zone, the budgets, notification preferences |
| Bot | Profile, model, permission mode, workspace path, engine project id |
| Conversation | One per bot. A sequence of entries, and how far the operator has read |
| Room | Name, members, host, when it was archived. A sequence of entries |
| Entry | A message or a card, with its author, its time, its delivery state and its fixed place (`order`) in its conversation or room |
| Session | J3 Bots' own id, its bot, its purpose (main or side), the engine thread id once the engine has one, the prompt version it was created with, its run count, the cursor of the engine events applied so far, and the turn it has admitted |
| Wake | Kind, priority, target bot, payload, hop count, status, and the dispatch that delivered it |
| Dispatch | One delivery to the engine: the target session, start or steer, the rendered envelope, the disposition the engine reported, the outcome. Several coalesced wakes share one |
| Ask card | For an `ask` question: the wake it came from and where its answer continues |
| Engine request | For an approval, an engine question or a secret request: the session, the engine's request id and the turn it belongs to |
| Catch-up note | What a bot's main session has not seen yet, consumed by its next main-session dispatch |
| Held message | A non-urgent teammate message waiting for the recipient's next envelope |
| Attachment | A file the operator sent or a bot produced: name, media type, size, digest, where it is stored |
| Routine | Bot, name, instruction, trigger, enabled, next run, recent runs |
| Device | A paired client: its token hash, its push token, when it was revoked |

Entries are ordered by `order`, set when the entry is created and never changed. The change sequence that clients resume subscriptions with is separate: it records when an entry changed, not where it sits.

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
 teammate message ─┼──> wake (persisted) ──> held by the server ──> dispatch (persisted) ──> engine session ──> turn
 routine trigger ──┤                              │
 system event ─────┘                              └── priority, budgets, coalescing, concurrency
```

### 1. A wake is recorded before anything happens

Creating a wake and the entry that caused it (the operator's message, the room message, the answered card) is one transaction. A wake that exists will be dispatched or visibly cancelled; one that does not exist never was requested. If the server stops between recording and dispatching, it picks the wake up again at start.

### 2. The server holds waiting wakes

J3 Bots owns waiting and priority. A pending wake stays in the server's database until its session can take it; the engine's queue is not used. Each wake has a priority from its kind: `user` first, then `room`, `bot`, `system`, and `routine`, oldest first within a priority.

For each pending wake the dispatcher applies, in order:

- **Budget.** A wake caused by a bot carries a hop count. If the chain that led here exceeds the limit, the wake is cancelled and the conversation or room shows that the chain stopped. See [Budgets](#budgets).
- **Readiness.** A wake is dispatched only into an idle session: no admitted turn and no turn the engine started on its own. The one exception is below: a `user` wake for a turn the operator opened.
- **Coalescing.** All pending wakes of a bot that are ready for the same session become one dispatch: three room messages that arrived while the bot was busy are delivered together.
- **Concurrency.** At most N turns run at once across all bots. Higher-priority wakes take a free slot first.
- **Blocked providers.** If the bot's provider is at its usage limit, routine and bot wakes wait for the reset. An operator wake is dispatched anyway so the operator gets the engine's own limit message.

| Wake | The session is idle | The session is in a turn |
| --- | --- | --- |
| `user` | Start a turn | If the operator opened the running turn, steer it, so they can redirect work in progress. Otherwise wait, first in line, so a private message never lands in a room turn |
| `room`, `bot`, `system` | Start a turn | Wait |
| `routine` | Start a turn in a new side session | Not applicable: side sessions run alongside the main one |

### 3. A dispatch is written before the engine is called

In one transaction the dispatcher renders the envelope, writes a **dispatch** with the target session, the delivery (start, or steer with the turn) and that envelope, links the coalesced wakes to it, and consumes the bot's catch-up note and held messages into the envelope. A dispatch never changes its session or its envelope afterwards; the database refuses it.

Then it calls the engine with the dispatch id as the key. The adapter derives the engine's command id and message id from that key ([Engine: the adapter's interface](engine.md#the-adapters-interface)), so sending the same dispatch again is the same command. The engine's answer is recorded as the dispatch's disposition:

| Disposition | Meaning | What the server does |
| --- | --- | --- |
| `started` | A new turn started | The turn is admitted (see below) |
| `steered` | The message joined the running turn | The wakes ride on that turn |
| `new-turn` | A steer arrived too late, or the provider cannot steer: the message became its own turn, possibly after the running one | The turn is admitted when it starts |

`start` into a session that turned out to be busy, because the engine started a turn of its own, is refused before anything is sent. The dispatch is abandoned and its wakes wait again.

**Reconciliation.** When the server cannot tell whether a dispatch reached the engine (it crashed during the call, or the engine dropped), it asks: `lookupDispatch` answers applied, not applied, or unknown. Applied records the disposition. Not applied sends the same dispatch again. Unknown waits and asks again. A dispatch moves to a replacement session only after a definite answer: applied means it ran where it was sent; not applied lets the server abandon it and dispatch its wakes afresh in the new session. The server never guesses, so a wake is never delivered twice and never silently lost.

### 4. The turn is observed, and admitted

The adapter streams each session's events, and the server derives the bot's state from them: thinking, working, waiting on a request, blocked, idle. Clients see that state live. Each event is applied and its cursor stored in one transaction, so a restart neither skips nor repeats one. A stream that resumes too late to replay starts with one replacement of the session's open state, and the server reconciles against it ([Engine](engine.md#the-adapters-interface)).

A session has at most one **admitted turn**: the turn bot tool calls bind to. A turn started by a dispatch is admitted with the dispatch's audience (the conversation, or the room for a room wake). A turn the engine started to continue an admitted turn keeps that audience. A turn the engine started on its own, after a restart with background work or when a background command finished, is admitted with the bot's own conversation as its audience.

What the bot *says* does not come from the event stream. It comes from the bot calling J3 Bots' `say` tool, which appends an entry to the admitted turn's audience and returns. A `say` or `ask` that arrives when the session has no admitted turn is refused with a typed error (`NoAdmittedTurn`), and nothing is delivered. A call to the engine's own `send_to_user` tool arrives as host speech and is delivered like a `say` without `done`, so a slip is not lost.

A `say` with `done: true` **closes the delivery**: the dispatch's wakes are finished, and the operator sees the bot's reply as delivered. It does not interrupt the run. The bot is expected to end its turn; if it keeps working, what it says next still reaches the same audience. The server never interrupts a run to end it, because an interrupt may drop the delivery of a delegated task's completion ([Engine](engine.md#behaviors-j3-bots-designs-around)).

The turn's final reply text is never published: the base prompt tells the bot it reaches nobody, and the bot may have used it for notes. If a `user` wake's turn ends without a `say` carrying `done: true`, a pending question or a background handoff, the server wakes the bot once more with an `undelivered` system wake. If that turn also delivers nothing, the conversation shows a notice with a retry action.

### 5. The outcome closes the dispatch

When the turn ends, the dispatch records how: completed, failed (with the engine's error class), interrupted, or waiting on the operator, and its wakes are finished. A failed routine wake is retried according to its routine's policy; a failed operator wake is shown in the conversation with a retry action.

The adapter knows which turn answers a dispatch because every engine run names the message that started it, and that message's id comes from the dispatch key. A turn the engine started on its own closes no dispatch.

### Stop

The operator's Stop is a separate path, never a side effect of `done`. In one transaction it cancels every wake the server still holds for the bot, and each one shows as cancelled where it came from. Then it stops each of the bot's sessions that has a turn: the running turn, its background work and anything the engine holds for it. The stop's engine key comes from the Stop command's id, so a retried Stop is the same stop.

## Questions, approvals and secrets

Two kinds of card wait on the operator, with separate lifecycles.

**A bot's `ask`** is a J3 Bots question. The card stores the wake it came from and where the answer continues: the conversation, or the room whose turn asked. The bot ends its turn after asking. The card does not expire. Answering or dismissing it closes the card and creates a `user` wake carrying the answer in the same transaction; that wake's turn delivers to the stored audience. The answer's envelope is defined in [Prompt architecture](../prompts/architecture.md#wake-envelopes).

**The engine's requests** belong to a running turn: an approval, a question asked through the harness's own tool, or a secret request. The card stores the session, the engine's request id and the turn. Answering it sends the answer to the engine for that turn, keyed by the answering command, and the turn continues. When the turn ends, every request still open on it expires, and its card shows that it expired.

**A secret request** comes from a bot calling the engine's `request_secret` tool. Its card shows the label, the reason, an optional link and a placeholder, never a value. The operator's answer travels in its own request (`secret.provide`), which hands the value straight to the engine. The value never enters an entry, a change, a log or a command receipt. The card records only that a value was provided, or declined, or that the request expired.

## Attachments

Files cross the server in both directions as attachments.

- A client uploads a file with `POST /attachments` before sending the message that carries it, and gets its id. `message.send` names up to ten. The server stores the bytes under `<J3_HOME>/attachments`, by digest, and the dispatch passes them to the engine with the message.
- A file a bot attaches to `say` is copied from its workspace into the same store, so the operator's devices can open it after the bot has changed or removed its copy. Paths outside the workspace are refused.
- `GET /attachments/:id` serves a file to a paired device only, with the device token as a bearer.
- `bot.files` lists the files a bot has produced, newest first, for the bot's details view.

Each file is limited to 25 MiB.

## Sessions

Each bot has one **main session**: an engine thread in the bot's project, where operator turns, room turns and teammate messages all land. One working context means a bot in a room can use what the operator told it privately, which is what makes it the same teammate everywhere.

**Side sessions** are short-lived engine threads in the same project, used for routine runs. They start with fresh context, see the same system prompt and memory files, and can deliver messages with `say` like the main session.

A session's id is J3 Bots' own, written before the engine is asked for a thread and used as the key of that request, so a retried creation cannot make a second thread. The engine's thread id is stored next to it once known, unique across sessions. The prompt version the session was created with is recorded too, so a session started on an older prompt can be found and rotated.

Because the main session does not see what a side session did, the server keeps a **catch-up note** per bot, in the database. When the bot next wakes in its main session, the envelope begins with what happened since: "Routine 'Morning repo check' ran at 08:03 and told the user: …". The note is consumed in the same transaction that writes that dispatch, so it is neither lost nor shown twice.

**Rotation.** The server replaces a bot's main session when any of these is true: it passed a threshold of runs, the engine reports a provider-side failure to resume, the operator changed the bot's provider, or the operator asked for a fresh start. The new session's first envelope carries a digest of the recent conversation. The conversation itself is untouched. The old session is retired, not deleted: its dispatches can still be looked up.

## Bot tools

Bots act on J3 Bots through a small MCP server named `j3`. The harness starts it as a local stdio process, one per loaded session; that process forwards each call to the J3 Bots server over loopback. It holds no state and does no work of its own, because a host with many recently active bots runs many of them (see [Engine](engine.md#footprint)).

The bridge identifies its caller from `T3CODE_THREAD_ID`, an environment variable the engine sets for each stdio MCP server the harness starts, with the session's thread id. The bridge reads it with `sessionOfToolCaller` from `packages/engine-t3` and never names the variable itself. The server maps that id to a session and a bot, and binds the call to the session's admitted turn ([the wake pipeline](#4-the-turn-is-observed-and-admitted)). A call from an unknown thread is refused. **Verified** on Claude Code on releases `4941` and `4969`, and on Codex from `4969`, the pinned release ([Engine](engine.md#version-pinning)).

The `j3` tools are pre-approved in every permission mode, so they never raise an approval card. How each harness is told so is in [Engine](engine.md#provisioning).

| Tool | Purpose |
| --- | --- |
| `say` | Deliver a message to the admitted turn's audience: the operator, or the room during a room turn. Optional attachments. `done` marks the delivery complete. |
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
| From the operator, mentions bots | Each mentioned bot, one at a time in the order mentioned |
| From the operator, mentions `@everyone` | Every member, one at a time in member order; each sees the replies before it |
| From the operator, mentions nobody | The host |
| From a bot, mentions another bot | The mentioned bot |
| From a bot, mentions nobody | Nobody. The room waits |

Mentions are structured: a message carries the bots it mentions, up to six, or `everyone`. The server never parses them out of the text.

A room wake is delivered into the bot's **main session**, wrapped in an envelope that names the room and carries only the entries the bot has not yet seen. During that turn `say` delivers to the room, and `say` with `to: "dm"` delivers privately to the operator.

A bot that has nothing to add ends its turn without calling `say`. That is the normal way a room goes quiet.

Approvals and questions raised during a room turn appear in the bot's own conversation. The room shows the bot as waiting.

## Deleting a bot

Deleting a bot removes its conversation, sessions, wakes, routines and memory, and retires its engine project. What it said elsewhere stays:

- Entries it wrote in rooms keep their author id. Nothing refers to the bot row, so the entries outlive it, and clients render the author as a deleted bot.
- If it hosted a room, the room passes to the member who joined first among the rest, in the same transaction. The database refuses to leave an active room without a host.
- A room left with fewer than two members is archived: it stays readable and takes no new messages.
- Files it produced stay in the attachment store while an entry refers to them.

## Teammate messages

`message_bot` appends a handoff card to the sender's conversation and creates a `bot` wake for the recipient.

- **Urgent** messages wake the recipient now.
- **Non-urgent** messages are held in the database and delivered at the top of the recipient's next envelope, whenever that is. They are consumed in the transaction that writes that dispatch.
- The sender gets an acknowledgement, never a reply. A reply is a separate `message_bot` call from the other side and arrives as a new wake.

The prompt tells bots not to acknowledge acknowledgements. The hop budget enforces it.

## Routines

A routine is a row with an instruction and a trigger. The server's scheduler owns it; the engine's scheduled tasks are not used.

- **Schedule triggers** are five-field cron expressions evaluated in the operator's time zone, with a five-minute minimum spacing.
- **One-time triggers** run once at a set time, in UTC, and then disable the routine. They are how "remind me tomorrow at nine" is kept.
- **Webhook triggers** are an HTTP endpoint on the J3 Bots server with a secret in the path and an optional HMAC signature. The request body reaches the bot as data inside a nonce-tagged block.
- A run that comes due while the previous run of the same routine is still going is skipped and recorded as skipped.
- Runs missed while the server was down are not replayed, except that each routine runs once on return if it missed at least one.
- A routine run ends in one of three ways: it said something (`say`), it finished silently with a result recorded in its history, or it failed.

Each routine keeps its recent runs with status, duration and what was delivered.

## Budgets

Three limits keep bots from spending the operator's allowance on each other. All three have conservative defaults and are part of the operator's settings (`settings.get`, `settings.update`), with the time zone and the notification preferences.

| Limit | Default | Applies to |
| --- | --- | --- |
| Hops | 4 | Consecutive bot-caused wakes in one chain since the operator last spoke |
| Fan-out | 1 | Bots a single bot message may wake, unless the operator asked for more |
| Concurrent turns | 2 | Turns running at once across all bots |

When a limit stops something, the place where it stopped says so in one quiet line. Nothing is dropped silently.

## Notifications

The server sends a notification when an entry is added to a conversation or room and no connected client currently has it in view, and when a bot starts waiting on the operator.

- **Web and desktop**: over the open connection, shown by the client.
- **Mobile**: a push through the platform's service. The payload carries the bot's name and, if the operator allows it, the first line of the message. See [open question 4](../open-questions.md).

Routines that end silently and non-urgent teammate messages never notify.

## Client API

Clients use one WebSocket to the server, with typed requests and subscriptions defined in `packages/contracts`, plus a few HTTP routes for what a socket does badly (pairing, file transfer).

**The socket is authenticated once, at the upgrade.** A client sends its device token as an `Authorization: Bearer` header, or, where it cannot set a header on an upgrade (a browser), a ticket it got from `POST /api/socket-ticket` with that bearer. A ticket works once and only within a minute. An upgrade without a valid credential is answered 401 and never becomes a socket. The socket belongs to that device for its whole life, and every request on it acts as that device. Revoking the device closes its sockets at once. This is how T3 Code's own socket works (**Read** at `db51b67`, `apps/server/src/ws.ts`).

**A failure stays with its request.** Each socket runs its own RPC server. A handler that fails unexpectedly fails its own request with a generic "Internal server error", and the cause is logged on the server; the socket and its other subscriptions carry on.

**Subscriptions** send the current state and then changes, as whole entities:

- The roster (every bot and room, with its state, a preview of its last entry and whether it is unread) and the engine status are small, so they always start with a snapshot and do not resume.
- A conversation or room resumes. Its snapshot holds the latest entries and the change sequence it was read at, its watermark; every later change follows, and nothing at or before the watermark does. A client that reconnects passes the last sequence it applied and gets the changes since, or, when the server no longer has them or there are too many, a fresh snapshot that replaces what the client holds.
- Routines resume the same way.
- The steps of a work fold stream while the operator has the fold open: every step so far, then each step as it changes, until the fold's turn ends.

Unread has one source of truth: the conversation's read mark against its newest entry. A bot that finished its turn is idle, and its reply is unread until the operator reads it; there is no separate "done" state.

**Commands** carry a client-generated id and are idempotent: send a message, answer a card, stop a bot, create or change a bot, a room or a routine, edit memory, change settings. `secret.provide` is the exception: it keeps no receipt, because a receipt would hold the value.

The server pages history by `order`; a client asks for older entries as the operator scrolls.

## Configuration

The server reads its settings from the environment. A default applies only when a setting is absent; a setting that is present but invalid stops the start, so a typo never becomes the default.

| Variable | Default | |
| --- | --- | --- |
| `J3_HOME` | `~/.j3-bots` | Refused inside a Git checkout, including a folder that does not exist yet whose parent is one |
| `J3_HOST` | `127.0.0.1` | Plain HTTP is refused on anything but loopback and private ranges (the private IPv4 ranges, carrier-grade NAT, where Tailscale puts its addresses, and IPv6 unique-local and link-local). `0.0.0.0`, `::` and host names count as public |
| `J3_PORT` | `3737` | |
| `J3_TLS_CERT`, `J3_TLS_KEY` | none | Set together, they serve HTTPS on any address |
| `J3_ENGINE_PORT` | `3738` | The engine's loopback port |
| `J3_ENGINE_BINARY` | the pinned release | For testing an engine build |

## Failure handling

| Failure | What the server does |
| --- | --- |
| The engine process exits | Restarts it, reconnects, and resumes each session's events from its stored cursor, by replay or replacement. The engine cancels the turn that was running: its dispatch is recorded as interrupted and handled like a failed one, and its open requests expire. Dispatches whose result was never recorded are reconciled with a lookup before anything is sent again. A steer the engine had turned into a held new turn is released with `queue.resume` |
| The engine socket drops | Reconnects with backoff, resumes each session's events, and reconciles dispatches in flight |
| A turn fails | Records the engine's error class on the dispatch and shows it; retries only routine wakes, with a cap |
| A provider hits its limit | Marks the provider's bots blocked with the reset time; holds automated wakes until then |
| The server process exits | On start, loads held wakes and reconciles every dispatch that was written but not recorded as applied. No turn starts twice, because a dispatch keeps its key and its envelope |
| A session cannot be resumed | Rotates to a new session seeded from memory and the recent conversation, after its dispatches in flight are reconciled |
