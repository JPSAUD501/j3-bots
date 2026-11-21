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

You need Claude Code installed, and an endpoint that speaks Anthropic's Messages API for it, as for `j3-bots provider connect` ([Running on a Pi](../docs/operations/running-on-a-pi.md#connect-the-providers)).

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
