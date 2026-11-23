# 0021: A missed routine runs only while it is nearer than the next

**Status:** Proposed

## Context

A routine's runs come due on the server's clock, and nothing runs while the server is not running. That used to be rare: the server ran on a machine that stays on. With the desktop app hosting its own server, it becomes normal. The server stops when the computer sleeps, shuts down or the app quits, and it can't tell those apart, or tell them from a crash.

Until now, a routine that missed runs while the server was down ran once when the server came back, however late, and then kept its schedule (**Read** at `ef19cd4`: `apps/server/src/routines/Scheduler.ts`, `start`). A daily 08:00 routine woken at 07:00 the next day ran at 07:00 and again at 08:00. An hourly one woken at :40 ran at :40 and again on the hour. A run was recorded with the time it started, and the bot was not told it was late, so a late "daily briefing" read "today" as the day it ran. Missed runs left no trace.

A run's status can't say "missed". A new value in routine runs changes the protocol, which the installed 0.2 Android app would then refuse ([Clients](../architecture/clients.md#protocol-compatibility)).

## Decision

**Only the latest run that came due can run, and only while it is nearer than the next one.** Take the latest run `s` that came due and the schedule's next run `n`. The routine runs now if `now − s ≤ (n − s) / 2`. Otherwise it runs nothing now, waits for `n`, and counts every run that came due as missed. There is one rule for every server, not a mode for the desktop: a server that was down for maintenance meets the same problem.

- The rule has no constant of its own. Its margin is half the schedule's own spacing, which is at least two and a half minutes, since runs are at least five minutes apart. A run a few seconds late always runs, a weekly report runs up to three and a half days late, and a clock change only makes one night longer or shorter. The gap is between runs, not days: a weekday 09:00 routine that missed Friday's run still makes it up on Saturday until 21:00, halfway to Monday's.
- **A one-time trigger always runs**, however late: a reminder that never arrives is worse than a late one.
- **A late run says so.** A scheduled run keeps when it was due. A run that started more than a minute after that tells clients (`RoutineRun.dueAt`, optional), and its envelope tells the bot (`due` on `<routine>`). The envelope's closing line has the bot read the instruction's dates against that time. An attempt tried again more than a minute after its run started gives that time too. The envelope also gives it, however little late the run is, when it was due on another day in the operator's zone: a run due at 23:59:45 that starts at 00:00:15 still does the work of the day before, though clients do not show it as late.
- **Missed runs are counted on the routine** (`Routine.missed: {count, since, until} | null`, optional), not as rows. They are counted only when the routine skips to its next run: after a downtime of several runs, a routine that makes up the latest one counts none of the earlier ones. The count clears when the routine's next run starts, or when it gets a new trigger, since those were the old trigger's runs. The server stops counting at 1,000, which clients read as "1,000 or more"; a client does not check a count against that limit, so a later server can raise it.
- **A run and the missed runs are told by the schedule's times.** A run postponed 30 seconds after it could not be recorded is still the 08:00 run: its `dueAt`, and `since` when it is missed, say 08:00.
- **The words are neutral.** Clients say "J3 Bots wasn't running", never asleep or off, because the server can't tell which.
- The contract only gains optional fields, so `PROTOCOL_VERSION` stays as it is. Migration 21 adds two columns (`routine_runs.due_at`, `routines.missed_json`). As with any migration, the release before refuses the database afterwards: it records a migration that release does not know. Going back to it is a rollback, which puts back the snapshot the update took ([0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)).

## Consequences

- A run that comes back past half its gap is not made up. Someone who wanted it has to run it from the routine's menu.
- A client of an earlier release, the 0.2 Android app among them, ignores both fields: it shows a late run as an ordinary one, and nothing of the missed runs.
- Webhooks are not covered. A webhook call made while the server is down reaches nothing and is recorded nowhere, so delivery depends on the caller retrying.

## Rejected

**Running once on return, however late, and showing it as late.** That keeps the "runs twice within an hour" problem and spends the person's plan on runs nobody wants anymore.

**A per-routine choice ("if missed: run on return / skip").** Every routine a bot creates would carry a setting most people never need, along with a tool parameter, a form field and prompt text to explain it.

**A `missed` run status.** It changes the protocol for a count the routine can carry. If a later release changes the protocol for another reason, a missed row in the history can be reconsidered then.

**Replaying every missed run.** A week asleep would start dozens of runs at once, all reporting the same thing.
