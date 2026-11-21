# 0005: J3 Bots owns scheduling and routing

**Status:** Accepted

## Context

T3 Code has scheduled tasks with interval, fixed-time, one-shot and webhook triggers, and tools that let one thread message another. J3 Bots could build routines and bot-to-bot messaging on them.

Reading the engine's behavior:

- a scheduled run is skipped when the previous one is still queued, and a fixed-time run more than ten minutes late is skipped;
- scheduled prompts and thread-to-thread messages arrive with T3 Code's own note prepended;
- a held queue is not released by a scheduled or tool-sent message;
- there is no cron syntax and no time zone per task;
- there is no notion of a budget across threads.

J3 Bots' server is always on and already has to decide which bot wakes for a room message.

## Decision

Every reason a bot starts a turn is a **wake**, created and dispatched by the J3 Bots server through one pipeline. J3 Bots has its own scheduler and its own webhook endpoints. Bots message each other through J3 Bots' tool. The engine's scheduled tasks and thread-messaging tools are not used.

J3 Bots also owns waiting and priority. A wake waits in J3 Bots' database until its session is idle, and is then started as a new turn; the one message it sends into a running turn is the operator's, steering a turn with the same audience. J3 Bots never asks the engine to queue a message. A room message is routed the same way: the operator's wakes the members it mentions, every member for `everyone`, or the host when it mentions nobody; a bot's wakes only the members its `say` lists in `mention`. A room runs one turn at a time ([0011](0011-a-room-runs-one-turn-at-a-time.md)). The engine still queues a start that meets a turn it began on its own in the same moment, and a steer its turn ended without taking; J3 Bots follows those rather than fighting them ([Server](../architecture/server.md#3-a-dispatch-is-written-before-the-engine-is-called)).

## Consequences

- One place applies budgets, priority, coalescing and concurrency limits to every kind of wake. A private message never goes inside a room turn: the operator steers only a turn with the same audience. It can be queued behind one only when the engine began that turn on its own in the moment the message was on its way, such as a room turn's continuation after a usage limit; it keeps its own audience while it waits, and its turn speaks privately.
- Every envelope is written by J3 Bots, in one format.
- A room's hop limit and the fan-out limit apply to room handoffs where they are made, in the `say` that makes them, as they do to teammate messages.
- The engine surface J3 Bots depends on shrinks to: create a thread, start a turn or steer a running one, stream events, answer a request, stop, and resume a held queue.
- The engine still holds its queue after a restart, a provider error or a Stop. Releasing it is the server's decision too: it resumes each hold the adapter reports once, and never while a Stop of the session is unsettled.
- The engine can still turn a steer into a new turn, when the steer arrives late or the provider cannot steer. The adapter reports what happened instead of assuming the steer landed.
- J3 Bots has to build a scheduler and webhook handling: authentication by a secret in the webhook's address, rate limits and deduplication.
- Bots still see the engine's scheduling and messaging tools in their tool list. The base prompt tells them J3 Bots' replace those.

## Rejected

**Use the engine's scheduler.** Less to build, and durable out of the box. Routines would behave by T3 Code's rules, change when those change, and sit outside J3 Bots' budgets.
