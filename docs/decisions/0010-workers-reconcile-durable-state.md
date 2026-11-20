# 0010: The turn machinery's workers reconcile durable state

**Status:** Proposed

## Context

The server sends the engine work from several places: the dispatcher, the recovery of dispatches whose answer was lost, the Stop runner, the responder that sends the operator's answers to engine requests, and the resumer of held queues. Each acts on state the database holds, and each meets the same troubles: an engine call that times out, a session the engine no longer has, a session whose events are not caught up, a Stop that holds a session, a nudge sent while no one listened. Workers that run only when nudged, and stop at the first session they cannot serve, leave work waiting for good, and let one session hold up every bot.

## Decision

Every worker is a reconciler ([Server: the workers](../architecture/server.md#the-workers)). A pass reads what is due from the database and does it. A signal only shortens the wait for the next pass, which also runs at the earliest durable deadline, a few seconds after a pass that left due work, and at a slow heartbeat otherwise. A signal is fired only when state changed.

A session that is lost, not ready, busy or unobservable holds back only its own rows; only the engine refusing commands ends a pass. "Busy" is a stored deadline, short and capped, that the session's next applied event clears, never a mark that waits for an event: a turn whose last event came before the refusal would leave it set for good.

Each worker is supervised where its loop meets one item, so a defect in one item never holds up the next, and is never retried at once. A defect counts against the bounds the item already has, with no bound of its own: in a dispatch's send, before the claim as a staging failure and after it as an indeterminate answer, so a repeating defect ends visibly within those bounds. Work whose key makes every send of it one command (an answer to an engine request, a held queue's resume) retries for as long as it is due, with capped backoff on a stored deadline, and has no count that gives up: giving up would leave a turn waiting on an answer the engine would have taken. A resume's result is recorded only if the hold it answered is still the current one.

## Consequences

- Correctness never depends on a nudge arriving; a lost one costs at most a heartbeat.
- Every deadline and retry count a worker needs is a column, so a restart resumes exactly where the last process stopped, and no startup step resets a count.
- An answer or a resume the engine never takes is sent again every ten minutes for as long as its request is open or its hold current; a dispatch still fails visibly at its bounds, because the operator must learn that it may never arrive.
- One bot's broken session never delays another bot's message.
- A worker does a little more reading than one that acts only on what it was told, and passes of one worker run one at a time.

## Rejected

**Workers driven only by signals.** Less reading. A signal lost to a timeout, a readiness change or a bug leaves its work waiting until something unrelated fires the same signal.

**One pass that blocks on a session until it is ready.** Simpler ordering. A lost or unobservable session stalls every other bot's work behind it.

**A retry count for idempotent work, reset at the engine's next ready edge.** Bounded retries. A count that ran out while the engine stayed up left the answer or resume waiting for a restart that might never come.

**A separate path for defects, retried after a fixed pause.** Simple. A defect that repeats on every send retried forever, and a Stop waiting on that dispatch waited a day for the recovery's age bound.
