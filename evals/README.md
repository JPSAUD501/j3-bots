# End-to-end evals

Evals that run the real J3 Bots server and engine against real models. They spend model allowance and take minutes, so they run on demand, never in `test` or CI. The one-turn prompt evals live in `packages/prompts/evals` ([Prompt architecture](../docs/prompts/architecture.md#evaluation)).

## The three-bot room

Checks M3's "done when" ([Roadmap](../docs/roadmap.md#m3-more-than-one-bot)): a three-bot room completes a multi-step task without a loop and without waking a bot that had nothing to do. Its deterministic counterpart, which runs in CI on the in-memory engine, is `apps/server/src/rooms/ThreeBotRoom.test.ts`.

Each run:

1. Starts the server from this checkout in a fresh `J3_HOME` inside a temporary folder, listening on `127.0.0.1` only. A server already on the port is never taken for it: only one that started after the spawn counts, and the spawned server exiting first ends the run.
2. Connects its providers with `j3-bots provider connect`, the key piped on standard input.
3. Pairs as a device with a code from `j3-bots pair`, and drives the server over the RPC socket as a client does.
4. Creates four Claude Code bots in `auto` permission mode: Hal, a team lead; Ana, a researcher; Bo, a writer; and Cy, a designer, the bystander. It waits until their first-run turns are over.
5. Creates a room of the four, hosted by Hal, with the default hop limit, and posts a task addressed to nobody: turn twelve pieces of fictional beta feedback into `release-notes.md`, with what is new and the three most requested features with their counts, and share the file in the room.
6. Waits until nothing has been under way for 30 seconds: no wake waiting or in a turn, no turn running, no background work a turn left.
7. Scores the run from the server's database and the shared file, then stops the server and deletes the run's home.

The task says who does what: Ana counts, Bo writes, Hal checks. It mentions none of them, so the work reaches Ana and Bo only if the bots hand it on with `mention`. The eval tests that handoff, not whether a host delegates unprompted. The task gives Cy no part, so any room wake of Cy's is a bot woken with nothing to do.

The feedback asks for CSV export four times, dark mode three, recurring transactions two and splitting a purchase once, so "the three most requested" has one right answer.

A run passes when all of these hold:

| Check                                                                                                                                                                                          | Read from                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A bot shared `release-notes.md` in the room                                                                                                                                                    | the room's bot attachments                                      |
| Its "Most requested next" section puts CSV export, dark mode and recurring transactions each on a line with its count (4, 3 and 2, in digits or words), and does not list splitting a purchase | the last shared `release-notes.md`, downloaded as a client does |
| Cy has no room wake                                                                                                                                                                            | the room's wakes                                                |
| At most 6 bot turns for the room                                                                                                                                                               | turns whose audience is the room                                |
| No `chain-stopped` notice                                                                                                                                                                      | the room's notices                                              |

The handoffs take four turns (Hal, Ana, Bo, Hal). The budget of six leaves Hal one round of sending the file back to Bo for a fix. A teammate woken with nothing to do is what Cy's wakes check; the report also gives the order of turns, where one shows as an extra turn for Ana or Bo. That the server runs one room turn at a time and wakes only the bots a message addresses is checked in CI, not here. The report also gives the highest hop count a room wake reached against the room's limit, which is how the default hop limit is checked.

A run must be over within 30 minutes of its start, boot included. A run that fails before it can be scored reports why and the last 20 lines its server wrote. The server's log never holds the endpoint's key: the server does not log it and drops the engine's output.

### Running it

You need Claude Code installed, and an endpoint that speaks Anthropic's Messages API for it, as for `j3-bots provider connect` ([Installing J3 Bots](../docs/operations/install.md#connect-the-providers)).

```sh
J3_EVAL_BASE_URL=http://127.0.0.1:8317 J3_EVAL_API_KEY=… pnpm --filter @j3-bots/evals room
```

| Variable           | Meaning                                                                                                     | Default                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `J3_EVAL_BASE_URL` | The endpoint's base URL, as `provider connect --base-url` takes it                                          | required                                         |
| `J3_EVAL_API_KEY`  | The endpoint's key. It is only ever written to the provider connection of each run's home, which is deleted | required                                         |
| `J3_EVAL_RUNS`     | How many runs, one after another                                                                            | 5                                                |
| `J3_EVAL_PORT`     | The server's port; the engine and the bot tools take the next two                                           | 3861                                             |
| `J3_EVAL_MODEL`    | The Claude Code model id the bots run on                                                                    | the first model the engine lists for Claude Code |

Runs never overlap, and nothing outside the temporary folder is written. The first run downloads the engine `engine.json` pins; later runs start it from there with `J3_ENGINE_BINARY`. The report is a Markdown table, one row per run, and the eval exits non-zero when any run fails.

## A team on the operator's word

Checks that a bot builds a team when the operator asks for one ([Rooms](../docs/architecture/server.md#rooms)): the primary bot creates teammates with `create_bot`, starts a room of them and itself with `start_room`, posts a kickoff, and a member answers there. Its deterministic counterpart, on the scripted agent, is `apps/server/scripted/team.test.ts`.

Each run starts, connects and pairs as the room eval does, on one harness, then:

1. Saves the operator's name, so the primary bot's hello asks for nothing, and creates the primary bot, Lia, in `auto` permission mode. It waits until her first-run turn is over.
2. Sends her, in Brazilian Portuguese, a request for a support group of several bots to help open the online shop of the operator's bakery. Who is in it, and what each does, is hers to decide.
3. Waits until a member other than Lia has a message in the room, or until nothing has been under way for 30 seconds.
4. Scores the run from the server's database, then stops the server and deletes the run's home.

Lia runs on the harness under test. The bots she makes take the model a bot created without one gets: the first model of the first ready provider as the engine lists them, whatever Lia runs on. With both connected, that was Claude Code's in every run so far. So a Codex run tests what a Codex bot does when asked for a team, and its members answer on that default; the report says which provider each ran on.

A run passes when all of these hold:

| Check                                       | Read from                   |
| ------------------------------------------- | --------------------------- |
| At least two bots made by `create_bot`      | Lia's tool calls            |
| A room hosted by Lia, with Lia a member     | the rooms and their members |
| Every bot she made is a member of that room | the room's members          |
| A message of hers in the room: the kickoff  | the room's entries          |
| A message of another member in the room     | the room's entries          |

The report also gives, per run, the provider each made bot runs on, how the other members' room wakes ended and the tools they called there, the hellos the made bots wrote in their own conversations (a bot made for a room opens there, so these should be none), Lia's tool calls in order, and her last message to the operator.

A run must be over within 20 minutes of its start, boot included.

### Running it

You need the harness's command installed (`claude` or `codex`), and an endpoint for it, as for the room eval. `team` is also a pnpm command, so name the script with `run`:

```sh
J3_EVAL_HARNESS=codex J3_EVAL_BASE_URL=http://127.0.0.1:8317 J3_EVAL_API_KEY=… pnpm --filter @j3-bots/evals run team
```

| Variable           | Meaning                                                           | Default                                          |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------ |
| `J3_EVAL_HARNESS`  | The harness Lia runs on: `claude-code` or `codex`                 | required                                         |
| `J3_EVAL_BASE_URL` | As for the room eval                                              | required                                         |
| `J3_EVAL_API_KEY`  | As for the room eval                                              | required                                         |
| `J3_EVAL_RUNS`     | How many runs, one after another                                  | 3                                                |
| `J3_EVAL_PORT`     | The server's port; the engine and the bot tools take the next two | 3871                                             |
| `J3_EVAL_MODEL`    | The model id Lia runs on                                          | the first model the engine lists for the harness |

Runs on different ports can go at once, one per harness.
