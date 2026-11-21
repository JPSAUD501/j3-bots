# 0013: Background work belongs to the turn that started it

**Status:** Accepted

## Context

A bot's turn can leave work running after it ends: a delegated task, a subagent, a command whose completion wakes the session. When that work finishes, the engine starts a turn nobody dispatched. A room's turn can do this as much as a private one, and all of a bot's work, private or for any room, runs in its one main session.

The engine reports what background work a session has, by the run that started it, but only while no run is active, and its stop ends the whole session: every turn, every queued run and all the background work it reaches, whichever turn started it ([Engine](../architecture/engine.md#the-adapters-interface)). A turn the engine starts says which earlier turn it continues only for a usage limit's continuation and a delegated task's completion. A harness's own wake, such as a background command's notice, names none ([Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)).

Without a link between a turn and the turn whose work started it, three rules break. A room's Stop cannot find the work a room turn left running once that turn ended. A turn the engine starts for a room turn's work speaks in the bot's conversation instead of the room. And its hops start again at 0, as if the operator had spoken, so a chain of bots can outrun the room's hop limit through background work.

## Decision

Background work belongs to the turn that started it, never to the session.

- Each turn records the turn of its session it continues, when the engine names one. It takes that turn's audience, and counts its hops and its Stops with that turn and the chain behind it.
- Each turn records whether background work it started may still be pending: set when the turn ends handing off to such work, then kept or cleared by each report of the session's pending work taken while nothing runs.
- A room's Stop targets a session while one of the room's turns there may have background work pending, as it targets the room's turns and dispatches.
- A room's Stop waits, unsent, while its session runs a turn for another audience. The engine's stop would end that turn too, and a room's Stop is never the operator's word about other work.
- A turn the engine started that names no turn never counts as the operator's word. It counts its hops from the session's turns whose background work was still pending; with none to trace it to, it wakes no teammate.

## Consequences

- A room turn's background work reports in the room, and reaches nobody once the room is archived or the bot has left it.
- A room's Stop, archival or deletion, and a member's removal, end the background work the room's turns started, and only once nothing of another audience runs in the session.
- The engine's stop is still the session's. A room's Stop ends private background work pending in the same session, without a notice, and private work waiting in the engine behind the room's turn, which it does not cover: a dispatch it drops fails as `stopped`, visibly and retryable, as before.
- A room's Stop can wait as long as the bot keeps running private turns. The operator can stop the bot, which ends everything at once.
- A harness's own wake cannot be tied to the turn whose work it reports. It speaks in the bot's conversation, a Stop covers it only if recorded while it runs, and its hops are bounded by the pending work it might report.
- The flag follows the engine's reports, which come only while nothing runs. A turn that ended handing off work stays flagged until such a report omits it.

## Rejected

**A flag kept for the whole session.** One column, set when any turn hands off work. The engine's rule for pending work does not ask which run started it, so the flag would make a room's Stop reach private work the room never started, and stay set after the room's own work ended.

**A room's Stop that ends whatever runs.** Simpler and never waits. The operator's private turn, or another room's, would end because a room they were not looking at was archived.

**Treating an engine-started turn as the operator's word, as before.** No tracking needed. Background work would restart every chain, so the hop limit would not bound bots that keep each other busy through it.
