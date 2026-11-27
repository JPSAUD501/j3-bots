# 0080: A routine's steps are each bot's own turns, driven by J3 Bots

**Status:** Accepted.

## Context

A routine was one instruction run by its bot. Operators ask for more than that: "every Monday, gather my emails, have Ana summarise them, and ask me before Bruno replies". The owner chose how such a routine looks, the Track (a rail of stations, one per step, with the bot's own face on each), and settled that the noun stays **Routine**, that a bot builds it from a conversation, and that it has no editor.

T3 Code 0.1.12 added durable workflows, and 0.1.13 gave them subjects and concurrency pools. A workflow is a script the engine runs; its agent steps are turns the engine starts:

- An agent step starts a new thread in a project, with the step's prompt as its first message and `createdBy: "system"`, on the project's default model unless the step names one; or it continues a thread it is given by queueing the prompt there (**Read** at `bc0f04d`, `workflows/WorkflowAgentThreads.ts`, `start`).
- Its result is the turn's end and its reply, or a structured output it was asked for; an interrupted or cancelled turn counts as `stopped` (**Read** at `bc0f04d`, `WorkflowAgentThreads.ts`, `result`; `WorkflowAgents.ts`, `AgentResult`).
- Cancelling a run interrupts its step's turn with the reason "Its workflow run was cancelled" (**Read** at `bc0f04d`, `WorkflowAgentThreads.ts`, `interrupt`).
- Runs, pauses, resumes and pools live in the engine's own database (migrations 110 to 119) and are driven by its own sweep (**Read** at `bc0f04d`, `workflows/WorkflowEngine.ts`, `persistence/Migrations`).

So there were two ways to run a routine's steps: J3 Bots drives each step as the step's bot's own turn, as it runs a routine today; or each step maps onto a step of an engine workflow.

## Decision

**A routine's steps run as J3 Bots' own wakes, each in a side session of the step's bot. The engine's workflows are not used.**

### What a routine is

A routine is a trigger and a list of **steps**, saved structured:

- a **bot step**: the bot that does it, what it does in a few words (`action`, as "gathers last week's emails"), and the brief its turn starts from (`instruction`);
- a **condition**: what must hold for the routine to go on (`check`, as "there's something new"). The bot of the step before says whether it holds. If not, the run stops there, quietly, and every step after is skipped;
- **your yes**: the run waits for the operator to say yes before it goes on. It may be asked only when something calls for it (`onlyIf`), which the bot of the step before judges. It waits a set number of hours at most.

Steps follow one shape: a bot step, then any number of (a condition, a yes, both in that order or neither, then a bot step), at most six bot steps. A routine whose steps are one bot step by its own bot is a **one-step routine**: it works and looks exactly as a routine always did, with no report asked of it, and every routine saved before this release is one.

The sentence a card reads the routine back in is composed by the clients from the steps, the bots' names and the trigger, never written by a model. The bot that builds the routine writes only the short phrases (`action`, `check`, `onlyIf`), and the station titles are those phrases after the bot's name.

A routine with several steps is not written into a bot's template: its steps name other bots, which a template does not carry, and its first step alone would be another routine under the same name ([0023](0023-a-bot-template-is-a-file.md)).

### How a run goes

A run copies the routine's steps when it starts. Everything in the run, the yes the operator gives included, follows that copy; a change to the routine applies from its next run. Before the first step, the run checks that every step's bot still exists, and ends as failed, saying which is missing, if one does not.

- **A bot step** is a `routine` wake of the step's bot, run by the routine runner as a one-step routine's run is: a fresh side session of that bot, with its own instructions and memory, opened on its provider and settings, under its turn budget and its provider's usage limit. Its envelope carries the routine, the step's brief, what each earlier step of this run reported, the operator's yes and note, and what the step must report for what comes next.
- **The report.** The step ends with one `finish_step` call: one line of result for the card, what the next steps need (a handoff), and, when a condition or a yes follows, whether the routine goes on and what to ask the operator. A step that cannot go on reports itself blocked, in words for the operator. The first report of an attempt is stored on the run's step; a second is refused. The run moves on only once the step's turn has ended, so nothing the turn still does can change what the next step starts from.
- **What a step says.** A step's bot may still `say` to the operator, as a one-step routine's run does; the message goes to that bot's own conversation, where it speaks for itself.
- **Your yes** shows inside the run's card in the conversation of the routine's owner: the question the step before wrote, its yes and no, and an optional note. A push notification of the existing `question` kind opens that card; nothing is ever answered from a notification. The wait has one deadline, fixed when the yes opens: the hours the step allows, but no later than the routine's next scheduled run. A yes starts the next bot step with the note in its envelope; a no, or the deadline, ends the run quietly. The answer, the deadline and a Stop each close the yes in the transaction that checks it is still open, so a late or second answer starts nothing. A run waiting for a yes is a run going: another run that comes due meanwhile is skipped, as it always was, and the deadline is applied before a new run is admitted.
- **Retries.** An attempt of a step is tried again by itself only when its turn never started (the engine could not open its session, or refused or dropped the turn before it began), as a one-step routine's attempt is. An attempt whose turn started and ended without a report, also one whose turn failed, ends the run as failed at that step: it may have done part of its work, and only the operator can judge whether running it again is safe.
- **Try again.** A run that failed at a step can be resumed from it by the operator while it is its routine's latest run and no other run is going. It keeps what the earlier steps reported and the operator's yes, and runs the failed step again; when that step's turn had started, the card says first that it may have done part of its work.
- **The run card.** Each run of a routine with several steps posts one `routine-run` entry in its owner's conversation, which the server updates as the run moves. Each step's bot shows as working in its own roster row; its plan, its little ones, its approvals and its questions to the operator are its own, in its own conversation.

### How a run settles

A run with several steps settles from its steps, not from its latest wake, into the five statuses clients know:

| Status | When |
| --- | --- |
| `running` | A step is going, waits for a slot or a retry, or the run waits for a yes |
| `delivered` | Every step ran, and one of them spoke with `say` |
| `silent` | Every step ran without a message; or a condition did not hold, the operator said no, or the yes's deadline passed |
| `failed` | A step was blocked or ended without a report, its attempts ran out, a step's bot was gone, or a Stop or a deletion ended it |
| `skipped` | It came due while another run was going |

The run's steps, each with its state and result line, travel beside the status, so a client tells a quiet end from a no.

### Stop and Force stop

A run with several steps belongs to its owner, also while another bot's step runs:

- **A Stop of the owner** ends its runs that are going, in the Stop's own transaction: the run is recorded stopped, a yes it waits for closes, the current step's wake is cancelled, its dispatch fenced, and, when that step's turn may be in the engine, a Stop is recorded on that step's side session alone, whichever bot it belongs to. That Stop ends the session's turn and its background work and offers Force stop like any other, and it covers none of that bot's other work. The owner's Force stop reaches it too.
- **A Stop of a step's bot** ends that bot's step as it ends the rest of its work, and the run with it.
- A run ended by a Stop is recorded as stopped on its own row and never tried again.
- **Deleting the routine or its owner** ends a run that is going the same way before the rows go.
- While a run is going, its card offers Stop, since its owner's own row may look idle.

### What it keeps

- **Only `packages/engine-t3` knows the engine** ([0001](0001-t3-code-as-unmodified-engine.md), [0002](0002-single-server-between-clients-and-engine.md)): a step is a turn in a side session, which the adapter already opens; nothing new crosses it.
- **A bot is one character with one memory**: a step runs as that bot, with its own instructions, memory and tools, through the bridge that knows who it is.
- **J3 Bots owns wakes** ([0005](0005-j3-bots-owns-wakes.md)): the scheduler starts a run and the runner moves it from step to step, and a turn slot, a provider's usage limit and a fresh start hold a step as they hold any automated wake.
- **A run needs no client and survives a restart.** The run's copy of its steps, each step's state, report and answer, and the yes's deadline are rows written in the transaction that moves the run; the runner reconciles from them, and a deadline that passed while the server was down is applied on its first pass.
- **History.** A run keeps each step's outcome and result line.

### Contracts

Additive; the protocol stays 11. A routine carries its `steps`; its `instruction` is the first step's, and an update of `instruction` alone changes the first step's brief. A run carries its steps' outcomes, as an optional field. A yes notifies as a `question`. An older client shows a routine with several steps by its first step's instruction, reads its runs by their status, and shows the run card as the line it shows for an entry it does not know.

## Costs

- **A step is a turn, and each turn costs.** A routine of three bot steps is three turns, each in a fresh session that starts from the bot's instructions and memory, not from the steps before beyond what they handed off.
- **A condition is judged by a bot, not computed.** "There's something new" is the step bot's reading, reported with `finish_step`. A wrong report goes on, or stops, wrongly; the card says what the bot reported.
- **A step that failed mid-way waits for the operator.** Only a turn that never started is tried again by itself, so a passing provider error during a step needs a Try again that a one-step routine would have made alone.
- **A step's background work does not hold the run.** The next step starts once the step's turn has ended. What the turn left running in the background, a server say, goes on in its session until it ends, the run ends, or a newer run starts, as for a one-step routine.

## Rejected

- **Steps as an engine workflow.** The engine would decide when a bot's turn runs, outside J3 Bots' wakes, turn budget and usage limits. A new thread for a step would not be the bot (no instructions, memory or bridge identity of its own), and continuing the bot's thread would put a second driver in a session J3 Bots dispatches into. Stop would have to cancel the engine's run as well as the turn, or the next step would start after it. The run's state would live in the engine's database, so J3 Bots' history, rollback snapshot and home export would see half of it, and `packages/engine-t3` would have to model workflows, approvals and runs for a feature the operator sees as a routine.
- **A model writes the routine's sentence.** It could say what the steps do not, and the card would claim one thing while the run did another.
- **One turn of the owner per run, delegating to teammates by message.** The steps would not be the other bots' own work in the card, and the run would depend on the owner's turn waiting for replies.
- **Waiting for a step's background work before the next step.** A step that started a server would hold its run forever; the turn's end is the step's end, as a turn's end is a one-step run's.
