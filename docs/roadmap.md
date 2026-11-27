# Roadmap

Milestones are ordered by what each one proves. Dates are not planned yet. Each milestone says what is built and whether it has met its exit test. The first release, [0.1.0](releases/v0.1.0.md), carries what is built up to M5.

## M0: Proof

Throwaway code. The goal is to turn every **Assumed** in the documentation into **Verified** or into a changed design.

Exit criteria:

1. A bot folder with a rendered `system.md` runs as an engine thread on Claude Code and on Codex, and its manner follows the base prompt.
2. The bot tool bridge works end to end: the harness starts it, it knows which session is calling, and a `say` call reaches a test server.
3. A full turn is driven over the client RPC from outside: create project and thread, dispatch, stream, answer an approval, answer a question, interrupt, resume after a dropped socket and after an engine restart.
4. The first behavior evals run and give a number for: acknowledgement first, reply length, silence on an empty routine, no reply to a teammate's FYI, refusing an injected instruction.
5. Measured on the target host: memory per idle and per active bot, cold-start time of a turn, tokens per turn for the base prompt plus the host's own text.
6. The adapter's first slice builds and runs against T3 Code's contracts, vendored at the pinned commit, outside T3 Code's monorepo.
7. A way to run the engine conformance suite without spending subscription allowance.

If criterion 1 fails on a harness, that harness is not supported, or the design changes. Everything else depends on it.

**Status.** Criteria 2, 3, 6 and 7 are met; 1, 4 and 5 in part.

- **1, in part.** The base prompt reaches the model from every layer on both harnesses and won a direct conflict with T3 Code's text ([Prompt architecture](prompts/architecture.md#how-each-layer-reaches-each-harness)). Whether the manner holds over many turns and after a compaction is [open question 1](open-questions.md#1-does-a-bots-manner-hold-on-top-of-the-hosts-prompts).
- **2 and 3.** **Verified** on a running engine ([T3 Code as an engine](research/t3-code.md#verified-on-a-running-server)).
- **4, in part.** The eval harness runs. The routine cases give a number for silence on an empty routine, and check acknowledgement first only in the routine setup case ([Prompt architecture: evaluation](prompts/architecture.md#evaluation)). Reply length, no reply to a teammate's FYI and refusing an injected instruction have no eval yet.
- **5, in part.** Memory is measured on a Raspberry Pi 4 ([Installing: Raspberry Pi](operations/install.md#raspberry-pi)). Tokens per turn and a turn's cold start are measured on a laptop only, before J3 Bots' base prompt, memory and tools were in place ([Engine: footprint](architecture/engine.md#footprint), [open question 5](open-questions.md#5-how-many-bots-does-a-host-and-a-subscription-sustain)).
- **6.** The adapter builds and runs against the vendored contracts ([Engine](architecture/engine.md)).
- **7.** The conformance suite runs on J3 Bots' scripted agent, with no model ([Engine: upgrading the engine](architecture/engine.md#upgrading-the-engine)).

## M1: One bot

The smallest thing worth using daily.

- Server: engine supervision, the adapter, bots, one conversation each, the wake pipeline for `user` and `system` wakes, `say` and `ask`, approvals, secret requests, attachments in both directions, memory with its tools, session rotation, settings.
- Web client: roster, conversation, details with the bot's files; cards for questions, approvals and secret requests; the work fold; pairing.
- First-run flow in which the bot opens the conversation.

Done when the project owner uses one bot every day for two weeks from the web client and the PWA.

**Status.** Built. Two weeks of daily use have not passed yet.

## M2: Work that starts on its own

- Routines: scheduler, side sessions, catch-up notes, run history, webhook triggers.
- Notifications on web, and the usage view.
- The routine skill and its evals.

Done when three routines have run unattended for two weeks, with silent runs staying silent.

**Status.** Built. Two weeks of unattended routines have not passed yet.

## M3: More than one bot

- Teammate messages, the primary bot, `create_bot`.
- Rooms, mentions and budgets.
- Room integrity: a room's Stop, also the operator's `room.stop`, ends background work its turns started, tracked by the turn that started it, and waits for another audience's turn rather than end it; retries and card answers check the room; a background turn speaks to its room; a removed member's work for the room ends ([Server: Rooms](architecture/server.md#rooms), [0013](decisions/0013-background-work-belongs-to-the-turn-that-started-it.md)).
- Budget enforcement and its notices.

Done when a three-bot room completes a multi-step task without a loop and without a bot that had nothing to do speaking.

**Status.** Done. The [three-bot room eval](../evals/README.md#the-three-bot-room) passed five runs of five on 2026-11-21, on Claude Code, and its deterministic counterpart runs in CI.

## M4: Every surface

- Desktop app: shell, global shortcut, native notifications, deep links, auto-update.
- Mobile app: the three regions, push notifications, dictation, share sheet.
- The avatar system and both themes, final.

Done when a conversation started on one device continues on the others with nothing lost, and a question answered on a phone resolves on the desktop.

**Status.** Built. The exit test is met on Linux and an Android emulator, with development builds; not yet with the release packages or on a phone.

- The [every-surface check](operations/every-surface-check.md) passes with the desktop app on Linux and the Android app on an emulator. Outside the check, the packaged desktop app has run on Windows 11, in a virtual machine, with the bots on that computer ([On the operator's own computer](#on-the-operators-own-computer)); it has not run on macOS.
- **Push notifications are built but cannot be turned on.** A build needs an Expo project and a Firebase configuration for them, and the project has neither, by the owner's decision, so no build turns push on and push has not been tried on a device ([Clients: mobile](architecture/clients.md#mobile)).

## M5: Public

- An install path a stranger can follow: one command to install J3 Bots and its pinned engine as a service, a check that tells them what is missing.
- The engine upgrade path with backup and rollback, exercised on at least three engine versions.
- A security review of the tool bridge, pairing and webhooks.
- Contribution policy, license settled, names settled.
- Documentation for operators.

**Status.** In part.

- **Built:** the one-command install, `j3-bots doctor`, `j3-bots update` with a snapshot to roll back to, the contribution policy and license, and the [operator documentation](operations/install.md).
- **Not yet:** the upgrade path is exercised on two engine versions, not three ([Releasing: the upgrade check](operations/releasing.md#the-upgrade-check)). The tool bridge, pairing and webhooks were each reviewed and hardened in a pull request of their own, but no one outside the project has reviewed them. The name is chosen, and whether it is free to use is [open question 10](open-questions.md#10-is-the-name-free-to-use).

## On the operator's own computer

- The desktop app runs J3 Bots itself, for someone with no always-on machine: its first screen offers "Use this computer", which signs that computer in without a pairing code and starts the server as the app's own child ([decision 0024](decisions/0024-the-local-server-is-a-supervised-child-of-the-app.md)). The bots sleep when the computer sleeps.
- Claude Code and Codex are signed in from the app, into J3 Bots' own homes for them.
- An app update moves the bots' data to the server it carries, and rolls back if that server never gets ready.
- A routine missed while J3 Bots was not running runs on its return only while that is nearer than its next run ([decision 0021](decisions/0021-a-missed-routine-runs-only-while-it-is-nearer-than-the-next.md)).

**Status.** Released on Linux x64 and Windows x64. On Apple silicon it is built but not offered until it has run on a Mac; an Intel Mac connects to a server only. A phone reaching these bots from outside the home network is a later step.

## The browser, secrets and connectors

The walkthrough is [A bot's browser, secrets and connectors](operations/browser-secrets-and-connectors.md); what guards each part is in [Security](architecture/security.md#the-browser-secrets-and-connectors).

- **The bot's browser.** A bot uses the engine's browser on the host only once its switch is on. The operator watches the page it works in from any client, takes control and hands it back, and a bot that meets a check, a sign-in, a second factor, a QR code or a passkey asks for help on a card instead of getting around it. One profile keeps the operator's sign-ins for every bot that has the browser.
- **Secrets.** Logins saved per site, with one-time codes, and single values such as an API token, typed by the operator and sealed on the server, with no password to unlock them. A bot asks for one on a card and uses it by a reference: the server types a login the bot may use into its page, or puts a value into a connector's settings, without handing the bot the value ([decision 0046](decisions/0046-secrets-the-operator-types-a-bot-uses-a-reference.md)).
- **Connectors.** MCP servers from a curated list and the MCP Registry, or by address or by command, for one bot, some or all. The operator asks a bot, and the bot adds one; an address in the operator's own network, or a service that needs an app the operator registers, waits on the operator's yes ([decision 0068](decisions/0068-settings-lists-what-the-bots-added.md)). The server signs in, OAuth included, keeps the sign-in with the operator's secrets, renews it and makes the calls; a connector's tools are those its server lists now, and follow the bot's permission mode.
- **Visuals.** A chart, a table, a diagram or a mockup a bot builds, shown in its message on the web, the desktop and Android, shut in a frame with no network.

**Status.** Released. Not proven yet:

- No sign-in to a real service: every OAuth flow ran against fake authorization servers, and the Google and Slack guides are **Assumed**.
- The browser has not been measured on a Raspberry Pi, nor run on Windows or macOS, and neither a help card nor a fill has been asked for by a real model end to end.

## Out of scope for now

- An iOS build of the mobile app. The app is written for both platforms, but only Android is built and released.
- Publishing to an app store. The Android app is a signed APK on each release.

## Later

- Bots on more than one host.
- Sharing a bot with another person.
- Voice.
- A semantic index over memory.
