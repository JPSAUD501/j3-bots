# 0010: The turn machinery's workers reconcile durable state

**Status:** Accepted

## Context

The server sends the engine work from several places: the dispatcher, the recovery of dispatches whose answer was lost, the Stop runner, the responder that sends the operator's answers to engine requests, and the resumer of held queues. Each acts on state the database holds, and each meets the same troubles: an engine call that times out, a session the engine no longer has, a session whose events are not caught up, a Stop that holds a session, a nudge sent while no one listened. Workers that run only when nudged, and stop at the first session they cannot serve, leave work waiting for good, and let one session hold up every bot.

## Decision

Every worker is a reconciler ([Server: the workers](../architecture/server.md#the-workers)). A pass reads what is due from the database and does it. A signal only shortens the wait for the next pass, which also runs at the earliest durable deadline, a few seconds after a pass that left due work, and at a slow heartbeat otherwise. A signal is fired only when state changed.

Each item has one owner, checked again inside the session's gate before a send: a stale read never sends another worker's item. The dispatcher makes every first send, also a staging retry of a dispatch never sent, under the turn budget; the recovery makes every resend of a key already claimed, and a first attempt given back is the dispatcher's again. Slot use is one fact the dispatcher reads again before each first send: work the engine may have, a turn its events show or a dispatch sent at least once and not settled. It is never inferred from what a send returned. The claim of a first start checks the same admission rule again in its own transaction, so a budget lowered, or a slot taken, while its files staged leaves it unsent for the dispatcher's next pass. A resend needs no observation of its session, since its key makes the engine apply it once; a first send needs the session's events known.

Every settlement of a dispatch that will not run to its end reads its outcome from one predicate, in its own transaction: whether a Stop covers the work. A Stop covers the work of every dispatch written before it was recorded, and of none after: each dispatch has a sequence number (`AUTOINCREMENT`, so never reused), and a Stop records the highest one when it is recorded. SQLite serializes writes, so that order is exact. Covered work is cancelled; otherwise work never sent waits again, work the engine dropped fails as `stopped`, and anything else fails with its own reason. A notice follows from that outcome.

A session that is lost, not ready, busy or unobservable holds back only its own rows; only the engine refusing commands ends a pass. A catch-up of one session that fails is that session's deferral. "Busy" is a stored deadline, short and capped, that the session's next applied event clears, never a mark that waits for an event: a turn whose last event came before the refusal would leave it set for good.

Each worker is supervised where its loop meets one item, every send in the dispatcher and the recovery included, so a defect in one item never holds up the next, and is never retried at once. A pass decodes its candidate rows one by one, so a row that cannot be read is postponed alone. An engine call made inside a session's gate has a deadline, a file's upload included, so a stalled call cannot hold the gate. A defect counts against the bounds the item already has, with no bound of its own: in a dispatch's send, before the claim as a staging failure and after it as an indeterminate answer, so a repeating defect ends visibly within those bounds. When counting it fails too, one write that touches only the dispatch's deadline postpones it. Work whose key makes every send of it one command (an answer to an engine request, a held queue's resume) retries for as long as it is due, with capped backoff on a stored deadline, the same backoff for a defect as for a lost reply, and has no count that gives up: giving up would leave a turn waiting on an answer the engine would have taken. A session's Stop work that hits a defect waits for a deadline stored on its targets. A resume's result is recorded only if the hold it answered is still the current one.

## Consequences

- Correctness never depends on a nudge arriving; a lost one costs at most a heartbeat.
- Every deadline and retry count a worker needs is a column, so a restart resumes exactly where the last process stopped, and no startup step resets a count.
- An answer or a resume the engine never takes is sent again every ten minutes for as long as its request is open or its hold current; a dispatch still fails visibly at its bounds, because the operator must learn that it may never arrive.
- One bot's broken session never delays another bot's message, and a defect in settling one dispatch never stalls another bot's recovery.
- A staging retry never takes a turn past the budget.
- Whether a room may start a turn is read from its dispatches and turns in the same way, again in the transaction that writes the dispatch, never kept as a flag that a crash could leave set ([0011](0011-a-room-runs-one-turn-at-a-time.md)).
- A worker does a little more reading than one that acts only on what it was told, and passes of one worker run one at a time.

## Rejected

**Workers driven only by signals.** Less reading. A signal lost to a timeout, a readiness change or a bug leaves its work waiting until something unrelated fires the same signal.

**One pass that blocks on a session until it is ready.** Simpler ordering. A lost or unobservable session stalls every other bot's work behind it.

**A retry count for idempotent work, reset at the engine's next ready edge.** Bounded retries. A count that ran out while the engine stayed up left the answer or resume waiting for a restart that might never come.

**A separate path for defects, retried after a fixed pause.** Simple. A defect that repeats on every send retried forever, and a Stop waiting on that dispatch waited a day for the recovery's age bound.

**Staging retries owned by the recovery.** One worker for every deadline. The recovery sends with no budget check, so a dispatch whose files failed to stage started a turn past the budget.

**Ordering a Stop and work by their times.** No extra column. Two writes in the same millisecond, or a clock stepped back, made work that began after a Stop look covered, and its retry vanished.

**A Stop predicate per settlement path.** Each path could ask what it knew: whether the dispatch was fenced, or which Stop came last. They disagreed when a second Stop or a room's archival came between the two, and a dispatch the operator had stopped was offered for retry.
