# 0010: The turn machinery's workers reconcile durable state

**Status:** Proposed

## Context

The server sends the engine work from several places: the dispatcher, the recovery of dispatches whose answer was lost, the Stop runner, the responder that sends the operator's answers to engine requests, and the resumer of held queues. Each acts on state the database holds, and each meets the same troubles: an engine call that times out, a session the engine no longer has, a session whose events are not caught up, a Stop that holds a session, a nudge sent while no one listened. Workers that run only when nudged, and stop at the first session they cannot serve, leave work waiting for good, and let one session hold up every bot.

## Decision

Every worker is a reconciler ([Server: the workers](../architecture/server.md#the-workers)). A pass reads what is due from the database and does it. A signal only shortens the wait for the next pass, which also runs at the earliest durable deadline, a few seconds after a pass that left due work, and at a slow heartbeat otherwise. A signal is fired only when state changed.

A session that is lost, not ready, busy or unobservable holds back only its own rows; only the engine refusing commands ends a pass. Each worker is supervised where its loop meets one item: a defect gives that item a later deadline or a bounded, visible outcome, and is never retried at once.

## Consequences

- Correctness never depends on a nudge arriving; a lost one costs at most a heartbeat.
- Every deadline and retry count a worker needs is a column, so a restart resumes exactly where the last process stopped.
- One bot's broken session never delays another bot's message.
- A worker does a little more reading than one that acts only on what it was told, and passes of one worker run one at a time.

## Rejected

**Workers driven only by signals.** Less reading. A signal lost to a timeout, a readiness change or a bug leaves its work waiting until something unrelated fires the same signal.

**One pass that blocks on a session until it is ready.** Simpler ordering. A lost or unobservable session stalls every other bot's work behind it.
