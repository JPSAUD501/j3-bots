# 0005: J3 Bots owns scheduling and routing

**Status:** Proposed

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

## Consequences

- One place applies budgets, ordering, coalescing and concurrency limits to every kind of wake.
- Every envelope is written by J3 Bots, in one format.
- The engine surface J3 Bots depends on shrinks to: create a thread, dispatch a message, stream events, answer a request, interrupt.
- J3 Bots has to build a scheduler and webhook handling, including signature checks, rate limits and deduplication.
- Bots still see the engine's scheduling and messaging tools in their tool list. The base prompt tells them J3 Bots' replace those.

## Rejected

**Use the engine's scheduler.** Less to build, and durable out of the box. Routines would behave by T3 Code's rules, change when those change, and sit outside J3 Bots' budgets.
