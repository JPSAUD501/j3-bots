# 0013: Background work belongs to the turn that started it

**Status:** Accepted

## Context

A bot's turn can leave work running after it ends: a delegated task, a subagent, a command whose completion wakes the session. When that work finishes, the engine starts a turn nobody dispatched. A room's turn can do this as much as a private one, and all of a bot's work, private or for any room, runs in its one main session.

What the engine tells J3 Bots about that work, and what it cannot:

- It reports a session's pending background work by the run that started it, only while no run is active, and also as pending work it attributes to no run (`BackgroundWork.unattributed`) (**Read** at `db51b67`, `orchestrationV2PendingBackgroundWork.ts:261`, `derivePendingBackgroundWork`).
- Its stop is the session's: `thread.stop` interrupts the active run, or the latest run's pending background work, and holds every queued run, whichever turn they belong to (**Read** at `db51b67`, `Orchestrator.ts`, the thread stop path, `dispatchThreadStop`). J3 Bots runs the engine unmodified, so it has no stop of one run.
- A turn the engine starts names the earlier turn it continues only for a usage limit's continuation (`usageLimitContinuationOfRunId`, **Read** at `db51b67`) and a delegated task's completion (`delegatedCompletion.parentRunId`, **Read** at `db51b67`, `ProviderContinuationService.ts:177-192`; **Verified** on release `4969` by the conformance suite). A harness's own wake, such as a background command's notice, names none (**Read**, `ProviderContinuationService.ts:247-264`) ([Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)).

Without a link between a turn and the turn whose work started it, three rules break. A room's Stop cannot find the work a room turn left running once that turn ended. A turn the engine starts for a room turn's work speaks in the bot's conversation instead of the room. And its hops start again at 0, as if the operator had spoken, so a chain of bots can outrun the room's hop limit through background work.

## Decision

Background work belongs to the turn that started it, never to the session.

- Each turn records the turn of its session it continues, when the engine names one. It takes that turn's audience, and counts its hops and its Stops with that turn and the chain behind it. It does not take the operator's word from it: a continuation or a completion of the operator's turn counts its chain's teammates against the fan-out limit.
- Each turn records whether background work it started may still be pending, and when the engine last showed it so: set when the turn ends handing off to such work, then kept or cleared by each report of the session's pending work taken while nothing runs. While any turn of a session has it set, each turn's end makes such a report due, and the Stop runner asks for it once nothing runs there.
- A room's Stop targets a session while one of the room's turns there may have background work pending, as it targets the room's turns and dispatches. Before it sends a round that has only that work left to end, it asks for a fresh report, and settles with no round when the report no longer lists it.
- A room's Stop waits, unsent, while its session has work for another audience: a turn running, or a dispatch the engine took whose turn no event shows yet. It judges this again inside the session's gate, right before it sends. Meanwhile the operator's steer may still reach the turn it waits for; no new turn starts.
- A turn the engine started that names no turn never counts as the operator's word. It counts its hops from the session's turns whose pending work the engine showed most recently, and keeps that count for the turns that go on with its own work; with none to trace it to, it wakes no teammate.

## Consequences

- A room turn's background work reports in the room, and reaches nobody once the room is archived or the bot has left it.
- A room's Stop, archival or deletion, and a member's removal, end the background work the room's turns started, once nothing the server sees of another audience runs in the session.
- The engine's stop is still the session's. A room's Stop ends private background work pending in the same session, without a notice, and private work waiting in the engine behind the room's turn, which it does not cover: a dispatch it drops fails as `stopped`, visibly and retryable, as before.
- A window remains in which a room's Stop ends the operator's private work. The check in the gate covers everything J3 Bots sends, since every send into the session is claimed in that gate. It cannot cover what the engine starts on its own: a harness's wake, a delegated task's completion or a usage limit's continuation that starts between the check and the engine applying the stop is interrupted with the room's work. With an unmodified engine this window cannot be closed, only kept to the time between one gate check and the engine's answer.
- A room's Stop can wait as long as the bot keeps running private turns. The operator can stop the bot, which ends everything at once.
- Background work the engine attributes to no turn (`unattributed`) is not reached by a room's Stop: nothing ties it to the room. A bot Stop reaches it, as it reaches every live session.
- A harness's own wake cannot be tied to the turn whose work it reports. It speaks in the bot's conversation, a Stop covers it only if recorded while it runs, and its hops are bounded by the pending work it might report. When the engine showed several turns' work pending at once, it counts the furthest of them; work the engine showed earlier does not count, so an older chain whose work has ended, but whose flag no report has cleared yet, does not refuse it.
- The flag follows the engine's reports, which come only while nothing runs. A turn that ended handing off work stays flagged until such a report omits it: the report due at each turn's end, or the one a room's Stop asks for, keeps that short.
- Turns that handed off work before this decision shipped are not flagged, so a room's Stop does not reach their work. No installation ran a release before it.

## Rejected

**A flag kept for the whole session.** One column, set when any turn hands off work. The engine's rule for pending work does not ask which run started it, so the flag would make a room's Stop reach private work the room never started, and stay set after the room's own work ended.

**A room's Stop that ends whatever runs.** Simpler and never waits. The operator's private turn, or another room's, would end because a room they were not looking at was archived.

**Holding the operator's steer behind a room's Stop that waits.** The rule every other first send follows. The Stop waits for the very turn the operator is talking to, so their word would wait for that turn to end, for no reason of the turn's own.

**Treating an engine-started turn as the operator's word, as before.** No tracking needed. Background work would restart every chain, so the hop limit would not bound bots that keep each other busy through it.
