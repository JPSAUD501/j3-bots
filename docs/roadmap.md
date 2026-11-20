# Roadmap

Milestones are ordered by what each one proves. Dates are not planned yet.

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

## M1: One bot

The smallest thing worth using daily.

- Server: engine supervision, the adapter, bots, one conversation each, the wake pipeline for `user` and `system` wakes, `say` and `ask`, approvals, secret requests, attachments in both directions, memory with its tools, session rotation, settings.
- Web client: roster, conversation, details with the bot's files; cards for questions, approvals and secret requests; the work fold; pairing.
- First-run flow in which the bot opens the conversation.

Done when the project owner uses one bot every day for two weeks from the web client and the PWA.

## M2: Work that starts on its own

- Routines: scheduler, side sessions, catch-up notes, run history, webhook triggers.
- Notifications on web, and the usage view.
- The routine skill and its evals.

Done when three routines have run unattended for two weeks, with silent runs staying silent.

## M3: More than one bot

- Teammate messages, the primary bot, `create_bot`.
- Rooms with a host, mentions and budgets.
- Budget enforcement and its notices.

Done when a three-bot room completes a multi-step task without a loop and without waking a bot that had nothing to do.

## M4: Every surface

- Desktop app: shell, global shortcut, native notifications, deep links, auto-update.
- Mobile app: the three regions, push notifications, dictation, share sheet.
- The avatar system and both themes, final.

Done when a conversation started on one device continues on the others with nothing lost, and a question answered on a phone resolves on the desktop.

## M5: Public

- An install path a stranger can follow: one command to install J3 Bots and its pinned engine as a service, a check that tells them what is missing.
- The engine upgrade path with backup and rollback, exercised on at least three engine versions.
- A security review of the tool bridge, pairing and webhooks.
- Contribution policy, license settled, names settled.
- Documentation for operators.

## Later

- Bots on more than one host.
- A desktop app that bundles the server and the engine for people with no always-on machine.
- Sharing a bot with another person.
- Voice.
- A semantic index over memory.
