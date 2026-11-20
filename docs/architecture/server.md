# Server

The J3 Bots server is the product. It owns what the operator sees and decides what every bot does next. This document describes its data, its one central mechanism (the wake pipeline) and the features built on it.

## Data

J3 Bots keeps two kinds of state, in two places, for two different readers.

**The database** (`<J3_HOME>/j3.sqlite`) holds what the server needs to query and what clients render:

| Entity | What it holds |
| --- | --- |
| Settings | One row: the operator's name, their time zone, the budgets, notification preferences |
| Bot | Profile, model, permission mode, workspace path, engine project id |
| Conversation | One per bot. A sequence of entries, and how far the operator has read |
| Room | Name, members, host, status (active or archived) and when it was archived. A sequence of entries |
| Entry | A message or a card, with its author, its time, its delivery state and its fixed place (`order`) in its conversation or room |
| Session | J3 Bots' own id, its bot, its purpose (main or side), the engine thread id once the engine has one, the prompt version it was created with, its run count, the cursor of the engine events applied so far, the turn it has admitted with that turn's audience, and the engine queue's current hold and the hold it last resumed |
| Wake | Kind, priority, target bot, audience, payload, hop count, status (pending, dispatched, finished, cancelled or failed), and the dispatch that delivered it |
| Dispatch | One delivery to the engine: the target session, the audience, start or steer, the rendered envelope and its files, how many times it was sent, the disposition the engine reported first if it reported one, the turn that delivers it, its status and, when it failed, why, a pending continuation of its turn, the Stop that fenced it, the outcome. Several coalesced wakes share one |
| Stop | The operator's Stop of one bot (scope `bot`), or of a room's work when the room is archived (scope `room`): its command id, and per target session and round the engine key and whether the events confirmed it stopped |
| Ask card | For an `ask` question: the wake it came from and the audience of the turn that asked |
| Tool call | A bot tool call pinned to the turn and audience it came from and to the engine's record of the call, with its result |
| Engine request | For an approval, an engine question or a secret request: the session, the engine's request id and the turn it belongs to |
| Catch-up note | What a bot's main session has not seen yet, consumed by its next main-session dispatch |
| Held message | A non-urgent teammate message waiting for the recipient's next envelope |
| Blob | File bytes, stored once per digest: size and where they are stored |
| Attachment | A file the operator sent or a bot produced: a name and a media type over a blob |
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
  memory/
    user.md          facts about the operator every bot can read
    log/2026-11.md   shared dated history
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

J3 Bots owns waiting and priority. A pending wake stays in the server's database until its session can take it; J3 Bots never asks the engine to queue a message. The engine still queues a start that meets a turn it began itself, and the server follows that (`queued`, below). Each wake has a priority from its kind: `user` first, then `room`, `bot`, `system`, and `routine`, oldest first within a priority.

For each pending wake the dispatcher applies, in order:

- **Budget.** A wake caused by a bot carries a hop count. If the chain that led here exceeds the limit, the wake is cancelled and the conversation or room shows that the chain stopped. See [Budgets](#budgets).
- **Readiness.** A wake is dispatched only into an idle session: no admitted turn, no dispatch that may be in the engine and is not yet finished (sent but unanswered, accepted, or delivered), and no turn the engine started on its own; a pending continuation holds back every wake but the operator's. The one exception is below: a `user` wake for a running turn with the same audience. Nothing at all is dispatched into a session while a Stop of it is unsettled ([Stop](#stop)).
- **Coalescing.** Pending wakes of a bot with the same kind and the same audience that are ready for the same session become one dispatch: three messages in one room that arrived while the bot was busy are delivered together. Wakes for different audiences never share a dispatch, so one turn always speaks to one place. Coalescing stops at the engine's limits for one message (`attachmentLimitViolation` on the dispatch's files together): the wakes that would break them wait for the next dispatch, oldest first, so a batch whose files do not fit becomes consecutive dispatches. A single wake always fits, because each message's files were checked when it was sent.
- **Concurrency.** At most N turns run at once across all bots. Higher-priority wakes take a free slot first.
- **Blocked providers.** If the bot's provider is at its usage limit, routine and bot wakes wait for the reset. An operator wake is dispatched anyway so the operator gets the engine's own limit message.

| Wake | The session is idle | The session is in a turn |
| --- | --- | --- |
| `user` | Start a turn | If the running turn has the same audience (the conversation, or the room the operator wrote in), steer it, so they can redirect work in progress. Otherwise wait, first in line, so a private message never lands in a room turn |
| `room`, `bot`, `system` | Start a turn | Wait |
| `routine` | Start a turn in a new side session | Not applicable: side sessions run alongside the main one |

### 3. A dispatch is written before the engine is called

Before anything is written, a message's files are checked against the engine's limits (`attachmentLimitViolation`: no empty file, inline images at most 10 MiB each and 80 MiB together). A message that breaks one is refused with nothing written.

In one transaction the dispatcher renders the envelope, writes a **dispatch** with the target session, the audience, the delivery (start, or steer with the turn), that envelope and its files in order, links the coalesced wakes to it, and consumes the bot's catch-up note and held messages into the envelope. A dispatch never changes its session, its audience or its envelope afterwards; the database refuses it.

Then it stages each file in the engine (`stageAttachment`) and stores the id the engine minted, raises the dispatch's attempt count, and calls `dispatch` with the dispatch id as the key. The adapter derives the engine's command id and message id from that key ([Engine: the adapter's interface](engine.md#the-adapters-interface)), so sending the same dispatch again is the same command. The staged ids are the one input that may change between sends: a file is staged again whenever its `usableUntil` has passed before a send, including a recovery, because the engine claims the files before it looks at the key; a copy a recovery does not use is removed by the engine. A retried staging after a lost reply leaves an unused copy the same way.

The engine's answer records **acceptance**. Its first disposition is stored and never changes:

| Disposition | Meaning | What the server does |
| --- | --- | --- |
| `started` | A new turn started | The turn is admitted when its `turn-started` arrives |
| `queued` | A turn the engine began while the start was on its way runs first; this message's turn waits behind it | The turn is admitted when its `turn-started` arrives, with this dispatch's audience, whatever the turn ahead of it was for |
| `steered` | The message was given to that turn | The dispatch waits for the steer to settle (see below) |
| `new-turn` | A steer arrived too late, or the provider can take no steer: the message became its own turn, possibly after the running one | The turn is admitted when its `turn-started` arrives |

A dispatch accepted through a recovery has no disposition: the engine does not say how a key it already had was applied. The events say where it went, as for any other.

**Delivery** is what the events say, not the disposition: a dispatch is delivered when `turn-started` arrives with the cause `dispatch` and its key, or, for a steer, when it settles as taken. A steer settles only after the turn it steered has ended, with one event right after that turn's `turn-finished`, decided by the engine's own state: `steer-requeued` (the engine queued it as a follow-up turn: the dispatch and its wakes move to that turn, which is admitted when it starts), `steer-dropped` (Stop ended the turn first: the dispatch is dropped, and the engine shows its own notice) or otherwise `steered` (taken: the dispatch finishes with that turn's outcome). `steered` is the engine's claim; on some provider paths it cannot prove the model read the message ([Engine](engine.md#the-adapters-interface)). Until it settles the dispatch is accepted and undecided, and no `undelivered` wake fires for it. A steer rides a turn it does not own: it finishes with that turn and never follows its continuation, which belongs to the dispatch that owns the turn.

Events about a key can arrive before the engine's answer does, after a lost reply. They prove it applied: the server records the dispatch as accepted, with no disposition, and applies them.

**Refusals.** Only two answers prove that the engine applied nothing, and only on a dispatch's first send, which they refuse before anything is sent:

- `SessionBusy`: the adapter already saw a turn in the session. It is a best-effort check; a turn that begins just after it gives `queued` instead.
- `SessionNotFound`: the adapter has no such session; the bot gets a new one ([Sessions](#sessions)).

Either one **releases** the dispatch: its wakes wait again, and its catch-up notes and held messages go back for the next envelope.

`DispatchRejected` means the engine's reply named a refusal, so it applied nothing and the key is spent. The dispatch **fails** as `rejected`. Its notes and messages are released, and its wakes fail visibly: each shows, where it came from, that it did not reach the bot. They never return to pending on their own, because the same wakes would be refused the same way; `message.retry` sends an operator message again as new wakes, under a new key.

**Recovery.** When the server cannot tell whether a dispatch reached the engine (it crashed during the call, or the call failed with `EngineIndeterminate`), it recovers the dispatch with `redispatch`: the same key, envelope, delivery and files, with none of `dispatch`'s local checks, because the key may itself have started the turn that makes the session busy. A lost reply is never taken as "not applied", and a dispatch with no recorded attempt was never sent, which is the only other proof of that. A recovery that succeeds means accepted, with no disposition. One that answers `DispatchRejected` fails the dispatch as `rejected`. Anything else is tried again with backoff, doubling from two seconds to ten minutes; while the engine is unreachable the server waits for it, and the wait counts no attempt. Three things end the recovery without an answer: ten indeterminate answers, the session being retired or removed (a rotation, a fresh start, a deleted bot), or the dispatch being older than a day. The engine keeps its receipts for good, so the day is J3 Bots' own bound, matching how long the engine keeps a session's events. The dispatch then fails as `unresolved` and its wakes fail visibly, never re-queued.

**Late delivery is legal.** If a turn later names a failed dispatch's key, the engine had applied it after all: the dispatch moves on to `delivered` and its turn goes to the dispatch's audience, and its wakes and messages show as delivered. A message the operator retried meanwhile went again under a new key, by their choice. A dispatch moves to a replacement session only through retried wakes. The server never guesses, so a wake is never delivered twice by J3 Bots' own doing, and never silently lost.

### One gate per session

Every step that sends a session something runs through that session's **gate**: one serial lock per session in the server process. A dispatch, a recovery, a held-queue resume, a Stop round and a room archival's Stop each take the gate, read the state they need inside it, make their engine call and record the result in one transaction, and release it. They never hold it while they wait for events or back off. So a Stop recorded while a dispatch waits for the gate fences that dispatch before it is sent, a resume never runs between a Stop's commands, and two recoveries of one key never overlap. Different sessions do not share a gate.

### 4. The turn is observed, and admitted

The adapter streams each session's events, and the server derives the bot's state from them: thinking, working, waiting on a request, blocked, idle. Clients see that state live. Each event is applied and its cursor stored in one transaction, so a restart neither skips nor repeats one. A stream that resumes too late to replay starts with one replacement of the session's state, and the server reconciles against it by stable ids (turn, request, speech and dispatch key), so a turn, a speech or a resolution it already applied changes nothing when it comes again ([Engine](engine.md#the-adapters-interface)).

A session has at most one **admitted turn**: its running turn, once the provider took it, with its **audience**, where its speech goes (the bot's conversation, or one room). A turn caused by a dispatch is admitted when it starts, with the dispatch's audience; a `queued` start keeps its own audience even when the turn ahead of it was a room's. A turn the engine started to continue another after a usage limit reset is admitted with the audience of the turn it continues ([Continuations](#5-the-outcome-closes-the-dispatch)). A turn the engine started for background work that finished is admitted with the bot's own conversation as its audience.

What the bot *says* does not come from the event stream. It comes from the bot calling J3 Bots' `say` tool, which appends an entry to the audience of the turn the call came from and returns ([Bot tools](#bot-tools)). A `say` or `ask` that cannot be matched to a call of the session's running turn fails with a typed `TurnEnded` result, and nothing is published or recorded. A call to the engine's own `send_to_user` tool arrives as host speech and is delivered once per speech id, like a `say` without `done`, so a slip is not lost.

A `say` with `done: true` **closes the delivery**: the dispatch's wakes are finished, and the operator sees the bot's reply as delivered. It does not interrupt the run. The bot is expected to end its turn; if it keeps working, what it says next still reaches the same audience. The server never interrupts a run to end it, because an interrupt may drop the delivery of a delegated task's completion ([Engine](engine.md#behaviors-j3-bots-designs-around)).

The turn's final reply text is never published: the base prompt tells the bot it reaches nobody, and the bot may have used it for notes. If a `user` wake's turn ends without a `say` carrying `done: true`, a pending question or a background handoff, the server wakes the bot once more with an `undelivered` system wake. If that turn also delivers nothing, the conversation shows a notice with a retry action.

### 5. The outcome closes the dispatch

When the turn ends, the dispatch records how: completed, failed (with the engine's error class), interrupted, or waiting on the operator, and its wakes are finished. A failed routine wake is retried according to its routine's policy; a failed operator wake is shown in the conversation with a retry action.

The adapter knows which turn delivers a dispatch because every engine run names the message that started it, and that message's id comes from the dispatch key; a steer's follow-up turn keeps the same message, and a run the engine restarted to take a steer keeps the message of its first attempt. A turn the engine started on its own closes no dispatch.

**Continuations.** A turn that fails at a usage limit may end with a pending continuation: the engine will resume it at the reset ([Engine](engine.md#the-adapters-interface)). Only the dispatch that owns the turn follows it. Its `turn-finished` then leaves the dispatch delivered rather than finished, with the outcome so far and the reset time recorded, and no `undelivered` wake fires. When the continuation turn starts, its cause names the turn it continues; the server follows that one link, moving the dispatch's turn and its audience to the new turn, so a chain of continuations is followed a link at a time. The dispatch finishes when a turn ends with no continuation pending, or when `continuation-dropped` arrives, with the last outcome; only then does an `undelivered` wake fire if nothing was delivered. A pending continuation keeps the session busy for automated wakes, which wait for the reset anyway. An operator wake is still dispatched; the engine then drops the continuation, because it resumes only the session's latest turn. A Stop disarms it too. J3 Bots never snoozes a session: snoozing would only delay the continuation. The engine's continuation after its own restart is turned off, so a turn a restart cut short ends `interrupted` like any other.

### Stop

A Stop is a separate path, never a side effect of `done`, and a durable one: it is written down before the engine is called, and finished after a crash. It has a **scope**: `bot`, the operator's Stop of one bot, which ends all of its work; or `room`, recorded when a room is archived, which ends only work whose audience is that room.

1. **Record.** In one transaction the server writes the Stop under its command id with its **targets**: every session of the bot with a turn, a turn waiting in the engine, background work, or a dispatch that may have been sent (`intended` with an attempt, `accepted` or `delivered`), in the Stop's scope. Each target's first round gets an engine key derived from the Stop's command id, the session id and the round. The same transaction **fences** every dispatch in scope that has not been accepted yet, so it is never sent for delivery again, and cancels every wake in scope the server still holds; each shows as cancelled where it came from. A fenced dispatch that was never sent is released, its wakes cancelled.
2. **Settle the fenced dispatches.** A fenced dispatch whose call may still be in flight is waited for. One whose reply was lost is recovered with its key before the stop, to learn the answer for it: if the engine had applied it, the recovery applies nothing; if it had not, the recovery applies it, and the stop that follows ends it. Either way nothing the bot was sent lands behind the Stop. One the engine refused fails, with its wakes cancelled.
3. **Stop each target.** `stop` with the round's key ends the running turn and the delegated work the engine can reach, cancels every turn waiting in the engine, drops untaken steers and disarms a pending continuation. The adapter derives each engine command from the key, so a retried round, or one resumed after a crash, sends the same commands. Its success only acknowledges the commands.
4. **Confirm from the events.** A target is stopped when the session's events show its effects: the running turn finished, every waiting turn finished, no continuation pending. A fenced dispatch the engine still applies after the round, which shows as a turn with its key, is stopped on sight in a new round. The Stop is finished when every target is stopped.

**A session with an unsettled Stop takes nothing.** From the moment its target is recorded until it is confirmed stopped, the server sends that session no dispatch (only the recoveries of step 2) and resumes no held queue in it. The engine's Stop is several commands, and a message arriving between them could restart a turn the Stop is ending ([Engine](engine.md#behaviors-j3-bots-designs-around)). The rule survives a restart: at start the server sends every unconfirmed round again before it opens those sessions' events.

The events close the rest: the running turn ends interrupted, a waiting turn ends cancelled and its dispatch is dropped, a dropped steer drops its dispatch. Under a `bot` Stop the wakes of a dropped dispatch are cancelled. The engine's Stop ends a whole session, so a `room` Stop also reaches private work in a member's main session: a private dispatch it fenced before sending is released, its wakes pending again; one the engine already had is settled like any other dispatch, and if the Stop drops it, its wakes fail as `stopped`, visibly and retryable, because the operator did not stop them. Background work the engine could not reach may still wake the bot later, as a background turn.

**Held queues.** The adapter reports each hold of a session's engine queue as a `queue-held` event, with the turns waiting behind it. The server stores the hold's cursor on the session and, through the session's gate, resumes it with `resumeQueue` naming that cursor, once: it stores the cursor of the hold it last resumed, and a hold equal to it is not resumed again. It never resumes while a Stop of the session is unsettled; the hold is resumed once the Stop is confirmed, if turns still wait. The engine refuses a resume on an archived session or at a usage limit, which leaves the queue to the engine's own rules.

## Questions, approvals and secrets

Two kinds of card wait on the operator, with separate lifecycles.

**A bot's `ask`** is a J3 Bots question. The card stores the wake it came from and the audience of the turn that asked: the conversation, or the room. The bot ends its turn after asking. The card does not expire. Answering or dismissing it closes the card and creates a `user` wake carrying the answer in the same transaction, with the stored audience; that wake's turn delivers there. The answer's envelope is defined in [Prompt architecture](../prompts/architecture.md#wake-envelopes).

**The engine's requests** belong to a running turn: an approval, a question asked through the harness's own tool, or a secret request. The card stores the session, the engine's request id and the turn. Answering it sends the answer to the engine for that turn, keyed by the answering command, and the turn continues. When the turn ends, every request still open on it expires, and its card shows that it expired.

**A secret request** comes from a bot calling the engine's `request_secret` tool. Its card shows the label, the reason, an optional link and a placeholder, never a value. The operator's answer travels in its own request (`secret.provide`), which hands the value straight to the engine. The value never enters an entry, a change, a log or a command receipt. The card records only that a value was provided, or declined, or that the request expired, from the request's resolution. `secret.provide` succeeds only when this call's own answer was the one the engine took. It has no receipt, so after a lost reply a retry may find the request closed: the server synchronizes the session and fails with `Conflict("card-closed")`, because the closing answer may have been another device's, or the request expired. A closed card is never reported as success; the card itself shows how it closed.

## Attachments

Files cross the server in both directions as attachments. Bytes and names are stored apart: a **blob** is the bytes, stored once under `<J3_HOME>/attachments` by their SHA-256; an **attachment** is a name and a media type over a blob. The same bytes sent twice, or under two names, are one blob and two attachments.

- A client uploads a file with `POST /attachments` before sending the message that carries it, and gets its id. The server puts its name and media type in the form the engine's upload takes (`normalizeAttachmentMetadata`: the name trimmed, the media type lowercased without parameters, at most 100 characters) and stores that, so a staging never fails on metadata. An empty file, a blank name or an unusable media type is refused; each file is limited to 25 MiB. `message.send` names up to ten, and the server checks them against the engine's limits before it writes anything: inline images (GIF, JPEG, PNG, WebP) at most 10 MiB each and 80 MiB together. Coalesced wakes are checked again together ([coalescing](#2-the-server-holds-waiting-wakes)).
- The dispatch lists its files in order. Before its first send, each is staged in the engine, which mints its own id for it; the server keeps that id with the dispatch, so a retry sends the same staged file. If the dispatch is still unsent when the staged file's `usableUntil` passes, the server stages it again.
- A file a bot attaches to `say` is copied from its workspace into the same store, so the operator's devices can open it after the bot has changed or removed its copy. Paths outside the workspace are refused.
- `GET /attachments/:id` serves a file to a paired device only, with the device token as a bearer.
- `bot.files` lists the files a bot has produced, newest first, for the bot's details view.

## Sessions

Each bot has one **main session**: an engine thread in the bot's project, where operator turns, room turns and teammate messages all land. One working context means a bot in a room can use what the operator told it privately, which is what makes it the same teammate everywhere.

**Side sessions** are short-lived engine threads in the same project, used for routine runs. They start with fresh context, see the same system prompt and memory files, and can deliver messages with `say` like the main session.

A session's id is J3 Bots' own, written before the engine is asked for a thread and used as the key of that request, so a retried creation cannot make a second thread. The engine's thread id is stored next to it once known, unique across sessions. The prompt version the session was created with is recorded too, so a session started on an older prompt can be found and rotated.

Because the main session does not see what a side session did, the server keeps a **catch-up note** per bot, in the database. When the bot next wakes in its main session, the envelope begins with what happened since: "Routine 'Morning repo check' ran at 08:03 and told the user: …". The note is consumed in the same transaction that writes that dispatch, so it is neither lost nor shown twice.

**Rotation.** The server replaces a bot's main session when any of these is true: it passed a threshold of runs, the engine reports a provider-side failure to resume, the operator changed the bot's provider, or the operator asked for a fresh start. The new session's first envelope carries a digest of the recent conversation. The conversation itself is untouched. The old session is retired, not deleted. A dispatch to it still waiting for an answer fails as `unresolved`.

## Bot tools

Bots act on J3 Bots through a small MCP server named `j3`. The harness starts it as a local stdio process, one per loaded session; that process forwards each call to the J3 Bots server's tool endpoint, an HTTP listener of its own on `127.0.0.1:J3_TOOL_PORT`, which stays on loopback whatever `J3_HOST` is. It holds no state and does no work of its own, because a host with many recently active bots runs many of them (see [Engine](engine.md#footprint)).

The bridge identifies its caller from `T3CODE_THREAD_ID`, an environment variable the engine sets for each stdio MCP server the harness starts, with the session's thread id. The bridge reads it with `sessionOfToolCaller` from `packages/engine-t3` and never names the variable itself. The server maps that id to a session and a bot. A call from an unknown thread is refused. **Verified** on Claude Code on releases `4941` and `4969`, and on Codex from `4969`, the pinned release ([Engine](engine.md#version-pinning)).

**Matching a call to its turn.** A request carries a session, not a turn, and the server's view of the session can trail the engine by a few events: a call made at the end of one turn could otherwise act for the next. So the server matches each request to the engine's own record of the call. The engine reports every `j3` tool call as a `tool-call` event in its turn, with the bare tool name and a digest of its input ([Engine](engine.md#the-adapters-interface)).

1. It picks a token, starts waiting for it, and calls `synchronize` for the session. When its event applier has applied the `synchronized` event with that token, every event the engine had when the request arrived has been applied.
2. It looks, in the session's running admitted turn, for an open call to the same tool whose input digest equals `toolInputDigest` of the request's arguments and that no other request has claimed. It takes the oldest.
3. The engine records the call apart from the request, so the call may not be there yet. Without a match the server synchronizes again, up to five times within two seconds.
4. With a match, the request is **pinned**: stored under the bridge's id for the request with the turn, the turn's audience and the engine's id for the call, which no other request can claim. Everything the request does acts for that turn and audience, even if the session admits another turn meanwhile.
5. Without one, the request fails with a typed `TurnEnded` result whose text the bot reads (`NO_TURN_REFUSAL` in `packages/prompts`), and nothing is published or recorded: the call belongs to a turn that has ended, or to no turn of this session.

**Subagents cannot speak.** A Claude Code subagent's tool call is recorded on the subagent's own thread, outside the bot's turn (**Read** at `db51b67`, `ClaudeAdapterV2.ts`, `startSubagentToolCall`; Codex is **Assumed** to do the same), so it never matches and is refused by step 5. The tool descriptions and the base prompt tell a subagent to report in its final reply instead.

**Duplicates.** Several requests may match one call: the bridge forwarding the same request twice under different ids, or a harness repeating an identical call. The oldest unclaimed request claims the call, and every other one is refused at step 5, so one call acts once. A later identical call is a call of its own, with its own engine record: the model made it twice, so it is accepted and acted on once more. That fails safe, because each call still acts exactly once: a repeated `say` shows twice, visibly, and a repeated `remember` is deduplicated.

**Size.** The engine shows a tool input over 16,384 bytes only as a summary, which no digest can match, so the tool schemas refuse arguments over 12,288 bytes with a message telling the bot to split them ([Engine](engine.md#behaviors-j3-bots-designs-around)).

A call whose audience is a room that is now archived fails with `Conflict("room-archived")`, and nothing is published.

The bridge gives each request one id and reuses it when it retries the forward, so a retry finds the stored request, acts for the same turn, and returns the stored result instead of acting twice. If the engine cannot be reached, the server retries the match until the request's deadline and then fails it as retryable.

The `j3` tools are pre-approved in every permission mode, so they never raise an approval card. How each harness is told so is in [Engine](engine.md#provisioning).

| Tool | Purpose |
| --- | --- |
| `say` | Deliver a message to the audience of the turn that made the call: the operator, or the room during a room turn. Optional attachments. `done` marks the delivery complete. |
| `ask` | Put one question to the operator as a card with options. Ends the turn. |
| `message_bot` | Send a message to a teammate. `urgent` wakes them now; otherwise it waits for their next turn. Returns only a delivery acknowledgement. |
| `remember`, `forget`, `recall` | Write, remove and search memory, in the bot's own scope or the shared one. |
| `set_routine` | Create, change, pause, resume or delete one of the bot's routines. |
| `list_teammates` | Names, titles and jobs of the operator's other bots and the rooms this bot is in. |
| `create_bot`, `update_bot` | Primary bot only by default: create a teammate with a name and a job, or refine one. |
| `update_profile` | Change this bot's own name, title or avatar when the operator asks. |

The complete parameter schemas and the wording of each description are part of the prompt package. See [Prompt architecture](../prompts/architecture.md#tools).

## Rooms

A room is J3 Bots data: members, host, entries, and a status. An active room has two to six members and a host among them. An archived room is read-only: it takes no messages and no changes but `pinned` and unarchiving, and it may have fewer than two members and no host. There is no engine object behind it.

**Archiving** a room, by the operator (`room.update` with `archived: true`) or because deleting bots left it too small, is one transaction that cancels every pending wake addressed to the room, expires the room's open `ask` cards (an answer can no longer reach it), and records a Stop for every member session whose turn, waiting turn or dispatch has the room as its audience. That Stop has the `room` scope and then runs as any other ([Stop](#stop)). A bot tool call whose audience is the archived room fails with `Conflict("room-archived")`, and host speech from a turn whose audience is the archived room is not published there, including speech a replacement replays after the archival. Unarchiving needs two to six members and a host, which the same update may give.

When an entry is added to a room, the server decides who wakes:

| The entry | Who wakes |
| --- | --- |
| From the operator, mentions bots | Each mentioned bot, one at a time in the order mentioned |
| From the operator, mentions `@everyone` | Every member, one at a time in member order; each sees the replies before it |
| From the operator, mentions nobody | The host |
| From a bot, mentions another bot | The mentioned bot |
| From a bot, mentions nobody | Nobody. The room waits |

Mentions are structured: a message carries the bots it mentions, up to six, or `everyone`. The server never parses them out of the text.

A room wake is delivered into the bot's **main session**, wrapped in an envelope that names the room and carries only the entries the bot has not yet seen. Its audience is the room: during that turn `say` delivers to the room, and `say` with `to: "dm"` delivers privately to the operator.

A bot that has nothing to add ends its turn without calling `say`. That is the normal way a room goes quiet.

Approvals and questions raised during a room turn appear in the bot's own conversation. The room shows the bot as waiting.

## Deleting a bot

Deleting a bot removes its engine project first, so nothing keeps running for a bot that no longer exists; while the engine cannot take that, the deletion fails with `Conflict("engine-unavailable")` and changes nothing. Then one transaction removes its conversation, sessions, wakes, routines and memory. What it said elsewhere stays:

- Entries it wrote in rooms keep their author id. Nothing refers to the bot row, so the entries outlive it, and clients render the author as a deleted bot.
- If it hosted a room, the room passes to the member who joined first among the rest, in the same transaction. The database refuses to leave an active room without a host.
- A room left with fewer than two members is archived, in the same transaction, as [Rooms](#rooms) describes: it stays readable, takes no new messages, and keeps no host if its host was the deleted bot.
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

**The socket is authenticated once, at the upgrade.** A client sends its device token as an `Authorization: Bearer` header, or, where it cannot set a header on an upgrade (a browser), a ticket it got from `POST /api/socket-ticket` with that bearer. A ticket works once and only within a minute. An upgrade without a valid credential is answered 401 and never becomes a socket. A browser cannot read that status, so a failed upgrade sends it back to the ticket route, whose own 401 is the signal to pair again ([Clients](clients.md#connecting)). The socket belongs to that device for its whole life, and every request on it acts as that device. Revoking the device closes its sockets at once. This is how T3 Code's own socket works (**Read** at `db51b67`, `apps/server/src/ws.ts`).

**A failure stays with its request.** Each socket runs its own RPC server. A handler that fails unexpectedly fails its own request with a generic "Internal server error", and the cause is logged on the server; the socket and its other subscriptions carry on.

**Subscriptions** send the current state and then changes, as whole entities:

- The roster (every bot and room, with its state, a preview of its last entry and whether it is unread) and the engine status are small, so they always start with a snapshot and do not resume.
- A conversation or room resumes. Its snapshot holds the latest entries and the change sequence it was read at, its watermark; every later change follows, and nothing at or before the watermark does. A client that reconnects passes the last sequence it applied and gets the changes since, or, when the server no longer has them or there are too many, a fresh snapshot that replaces what the client holds.
- Routines resume the same way.
- The steps of a work fold stream while the operator has the fold open: every step so far, then each step as it changes, until the fold's turn ends.

Unread has one source of truth: the conversation's read mark against its newest entry. A bot that finished its turn is idle, and its reply is unread until the operator reads it; there is no separate "done" state.

**Commands** carry a client-generated id and are idempotent: send a message, answer a card, stop a bot, create or change a bot, a room or a routine, edit memory, change settings. `secret.provide` is the exception: it keeps no receipt, because a receipt would hold the value; a retry that finds the card closed fails with `Conflict("card-closed")` instead.

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
| `J3_TOOL_PORT` | `3739` | The bot tool endpoint's loopback port, which the `j3` bridges call |

## Failure handling

| Failure | What the server does |
| --- | --- |
| The engine process exits | Restarts it, reconnects, sends again every unconfirmed Stop round, and resumes each session's events from its stored cursor, by replay or replacement. The engine cancels the turn that was running and its open requests expire; the turn's dispatch is recorded as interrupted and handled like a failed one (the engine's restart continuation is turned off). Dispatches whose answer was never recorded are recovered with their key before anything new is sent. The server resumes each reported hold once, except in a session with an unsettled Stop |
| The engine socket drops | Reconnects with backoff, resumes each session's events, and recovers the dispatches whose reply was lost |
| A turn fails | Records the engine's error class on the dispatch and shows it; retries only routine wakes, with a cap |
| A provider hits its limit | Marks the provider's bots blocked with the reset time; holds automated wakes until then. The turn that hit it stays open as a pending continuation, and a dispatch already waiting in the engine starts at the reset |
| The server process exits | On start, sends again every unconfirmed Stop round, loads held wakes, and recovers every dispatch that was sent but has no recorded answer. No turn starts twice, because a dispatch keeps its key and its envelope |
| A session cannot be resumed | Rotates to a new session seeded from memory and the recent conversation, after its dispatches in flight have an answer or fail as `unresolved` |
