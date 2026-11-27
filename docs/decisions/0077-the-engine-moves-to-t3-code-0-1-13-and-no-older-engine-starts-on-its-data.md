# 0077: The engine moves to T3 Code 0.1.13, and no older engine starts on its data

**Status:** Accepted.

## Context

J3 Bots 0.11.0 pins T3 Code 0.1.11. Since then T3 Code published two stable releases, 0.1.12 on 2026-11-25 and 0.1.13 on 2026-11-26, the one GitHub shows as the latest (**Verified** on 2026-11-26). J3 Bots pins only stable releases ([engine.md, Version pinning](../architecture/engine.md#version-pinning)).

Between the two pins the engine changed in ways an existing J3 Bots feature meets:

- **Its environment.** When its own environment lacks `T3CODE_FEATURE_FLAGS`, the engine copies the one the server user's login shell exports, which is meant for their own T3 Code (**Read** at `bc0f04d`, `os-jank.ts`).
- **Its browser.** It downloads Chrome 158 instead of 157, and keeps the version it replaced beside the new one (**Read** at `bc0f04d`, `PreviewBrowser.ts`).
- **Secret requests.** A request may ask for named values (`fields`), answered one per name, and an answer of a single value to it is refused (**Read** at `bc0f04d`, `SecretRequests.ts`).
- **Approvals.** Codex's prompt for a command now follows the command with the directory it runs in and the host it reaches (**Read** at `bc0f04d`, `CodexAdapterV2.ts`). The engine's own pull-request tool asks the operator before it runs a repository's push hooks that changed, and that question is no longer answered for it in Full access: it reaches J3 Bots as a tool approval, which the card already shows as the engine words it.
- **Deleted threads.** A read of a deleted thread now fails as a missing one, instead of returning the thread stamped deleted (**Read** at `bc0f04d`, `ProjectionStore.ts`).
- **Its own data.** 0.1.13 migrates its database through 17 migrations it adds (103 to 119) and may rewrite its settings. An older engine started on that data starts all the same, logging only that the migrations diverge from its build, and then fails on what it cannot read: a thread holding an item it does not know, or the whole settings file once a value in it is new (**Read** at `bc0f04d` and at `59651c1`, `persistence/Migrations.ts`). Only the check T3 Code's own `t3 update` runs first refuses such data, and J3 Bots never runs that command. [Decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md) assumed the engine refused it.

The engine's wire protocol is still 2, and every event and item 0.1.13 adds is one the adapter can ignore: they decode, and nothing J3 Bots asks of the engine produces them.

## Decision

**J3 Bots 0.12.0 pins T3 Code 0.1.13, takes from it only what an existing feature needs, and never starts an engine on data a newer one migrated.**

- **The pin.** `engine.json` names 0.1.13, commit `bc0f04da94f64b5e487c598761a43b4cf06b2ac9`, and the release's own digests. The vendored contracts are re-copied from that tag, and the Effect catalog follows T3 Code's to 4.1.5. Client contracts do not change: protocol 11 holds.
- **The adapter keeps every behaviour it had.** The engine starts with `T3CODE_FEATURE_FLAGS` set and empty, so nothing of the operator's T3 Code reaches it. The browser's host check reads the version the engine runs, which the adapter now names, and not one it kept from before. A read of a deleted thread is a lost session, as it always was; the filter that found it in the old reply goes. A Codex command's card gives the directory and host as context, not the command again. A secret asked for as one field is the card it always was, answered under the field's name.
- **The update and the rollback keep the engine's data with J3 Bots'.** The update's snapshot already held the engine's database and settings beside `j3.sqlite`, so a rollback, or an update that failed, starts the older engine on its own data. What a by-hand downgrade could still do, J3 Bots now refuses: its database records the newest engine release that ran on the home (`engine_release`), and before the engine starts the server refuses to start an older one, naming both and the rollback. The record travels in the snapshot with the data it describes. A release from before it refuses the database for the migration that adds it. The desktop app's server is the same server and refuses the same way.
- **Every evidence marker is re-checked.** A fact the documents and code comments marked **Read** or **Verified** at 0.1.11 was read again at `bc0f04d`, and either moved to it or rewritten. A **Verified** fact stays verified on the release it was observed on, and says whether the code it rests on changed. The conformance suite, the policy cases included, passed against 0.1.13 on 2026-11-26.

### What 0.1.13 offers that J3 Bots does not use yet

Each of these is a feature of the engine with no J3 Bots feature behind it yet. The adapter decodes what they add to the protocol and ignores it.

- **Workflows** (0.1.12, beta; subjects and concurrency pools in 0.1.13): durable runs of agents with schedules, webhooks and human approvals. They come in their own release, once a design for J3 Bots' operators is chosen.
- **A run's structured output** (`outputSchema`, `run.output-submitted`): a turn asked to return data matching a schema.
- **Multi-repository projects** (workspace folders, `GitRefName` branches): one project and thread across several repositories.
- **Linked threads and the connections map** (beta): reading and driving threads on other linked machines.
- **Agent feedback** (`feedback_request`): an agent asking the user to send a report to T3 Code's team. Off by default, and left off.
- **MCP sign-in from a thread** (`mcpSignIn`): J3 Bots holds a connector's sign-in itself ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)).
- **Milestones**: coarse state changes a consumer could be told about.
- **Multi-value secret cards** (`fields` with more than one entry): J3 Bots' secret card holds one value, so such a request shows no card and waits until the engine times it out. The base prompt tells a bot to ask for one value per call.
- **A select's menu in the browser viewer** (`selectMenu`): the engine now offers a page's dropdown to the viewer to draw. J3 Bots' viewer drops it, so a dropdown cannot be opened with the pointer; it never showed in the stream before either (**Assumed**: Chromium draws that popup outside the page).
- **Asynchronous assistant messages** (`delivery: "async"`, Codex only): bots speak through `say` ([decision 0004](0004-speech-is-a-tool.md)), so assistant text is not read.
- **Device hub, push hooks, Apple Speech, large file previews**: features of T3 Code's own apps.

## Costs

- **A first start after the update is slower.** The engine's migrations build indexes in proportion to its tables, on a large home for some time, before it is ready. The update's wait for readiness is unchanged.
- **The first browser use after the update downloads about 130 MB,** and the old browser stays on disk beside the new one, for a rollback, until the engine's next browser update removes it.
- **A downgrade by hand needs the rollback.** Someone who installs an older release over a newer one now gets a refused start instead of a server that runs and fails later. The message names `j3-bots update --rollback`.
- **An older release's import still bypasses the record.** `j3-bots import --replace` run with a release from before 0.12.0, on a home a newer engine ran on, puts a database without the record in place and keeps the engine's data, so that release's server starts its older engine on it. A release cannot be changed after it shipped; the rollback, not an older release's import, is the way back.
- **An engine build under test is unchecked.** With `J3_ENGINE_BINARY` set, the release that runs is not the pinned one, so the server neither checks nor records it.

## Rejected

- **A state per engine release** (`engine/<version>/`). Rollback would need no copy, but every bot's sessions and projects would be left behind at each update, and the engine's data would be stored twice. The snapshot already holds what an older engine reads.
- **Running the engine's own preflight before each start.** The check `t3 update` runs is an internal command, named as one, that knows only the engine's database and would tie J3 Bots to a part of T3 Code it does not document. The record covers the settings too, and lives where J3 Bots' own checks are.
- **Pinning 0.1.12.** It was stable for a day; 0.1.13 carries its fixes, the browser's security update among them.
