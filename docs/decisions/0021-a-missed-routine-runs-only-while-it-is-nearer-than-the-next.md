# 0021: A missed routine runs only while it is nearer than the next

**Status:** Proposed

## Context

A routine's runs come due on the server's clock, and nothing runs while the server is not running. That used to be rare: the server ran on a machine that stays on. With the desktop app hosting its own server, it becomes normal. The server stops when the computer sleeps, shuts down or the app quits, and it can't tell those apart, or tell them from a crash.

Until now, a routine that missed runs while the server was down ran once when the server came back, however late, and then kept its schedule (**Read** at `ef19cd4`: `apps/server/src/routines/Scheduler.ts`, `start`). A daily 08:00 routine woken at 07:00 the next day ran at 07:00 and again at 08:00. An hourly one woken at :40 ran at :40 and again on the hour. A run was recorded with the time it started, and the bot was not told it was late, so a late "daily briefing" read "today" as the day it ran. Missed runs left no trace.

A run's status can't say "missed". A new value in routine runs changes the protocol, which the installed 0.2 Android app would then refuse ([Clients](../architecture/clients.md#protocol-compatibility)).

## Decision

**Only the latest run that came due can run, and only while it is nearer than the next one.** Take the latest run `s` that came due and the schedule's next run `n`. The routine runs now if `now − s ≤ (n − s) / 2`. Otherwise it runs nothing now, waits for `n`, and counts every run that came due as missed. There is one rule for every server, not a mode for the desktop: a server that was down for maintenance meets the same problem.

- The rule has no constant of its own. Its margin is half the schedule's own spacing, which is at least two and a half minutes, since runs are at least five minutes apart. A run a few seconds late always runs, a weekly report runs up to three and a half days late, and a clock change only makes one night longer or shorter.
- **A one-time trigger always runs**, however late: a reminder that never arrives is worse than a late one.
- **A late run says so.** A scheduled run keeps when it was due. A run that started more than a minute after that tells clients (`RoutineRun.dueAt`, optional), and its envelope tells the bot (`due` on `<routine>`). The envelope's closing line has the bot read the instruction's dates against that time. An attempt tried again more than a minute after its run started gives that time too.
- **Missed runs are counted on the routine** (`Routine.missed: {count, since, until} | null`, optional), not as rows. The count clears when the routine's next run starts, or when it gets a new trigger, since those were the old trigger's runs. It stops at 1,000, and finding the latest run reads at most that many runs of the schedule.
- **The words are neutral.** Clients say "J3 Bots wasn't running", never asleep or off, because the server can't tell which.
- The contract only gains optional fields, so `PROTOCOL_VERSION` stays as it is. Migration 21 adds two columns (`routine_runs.due_at`, `routines.missed_json`) and rebuilds no table, so the release before it still reads the database.

## Consequences

- A run that comes back past half its gap is not made up. Someone who wanted it has to run it from the routine's menu.
- A client of an earlier release, the 0.2 Android app among them, ignores both fields: it shows a late run as an ordinary one, and nothing of the missed runs.
- A run postponed after it could not be recorded (30 seconds) stands for the run it was due for. It can show as late by that much.
- Webhooks are not covered. A webhook call made while the server is down reaches nothing and is recorded nowhere, so delivery depends on the caller retrying.

## Rejected

**Running once on return, however late, and showing it as late.** That keeps the "runs twice within an hour" problem and spends the person's plan on runs nobody wants anymore.

**A per-routine choice ("if missed: run on return / skip").** Every routine a bot creates would carry a setting most people never need, along with a tool parameter, a form field and prompt text to explain it.

**A `missed` run status.** It changes the protocol for a count the routine can carry. If a later release changes the protocol for another reason, a missed row in the history can be reconsidered then.

**Replaying every missed run.** A week asleep would start dozens of runs at once, all reporting the same thing.
