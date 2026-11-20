# Roster

> Working name. Design phase: this repository holds the product and architecture plan. There is no application code yet.

Roster gives you a small team of persistent AI teammates ("bots") that run on your own machine, on the model subscriptions you already pay for.

Each bot has a name, a job, one ongoing conversation with you, and its own memory. Bots keep working when you close the app. They wake up on a schedule or when something happens, message each other, and work together in group chats. You talk to them from a phone, a desktop app, or a browser.

Roster does not run models itself. It drives an unmodified [T3 Code](https://github.com/pingdotgg/t3code) server as its engine. T3 Code already knows how to run Claude Code, Codex and other agent harnesses on your subscriptions, keep their threads durable, queue and steer turns, and handle approvals. Roster adds the layer above: bots, conversations, memory, routines, bot-to-bot messaging, group chats and clients built for talking to teammates instead of managing coding threads.

## Status

| Area | State |
| --- | --- |
| Product concepts | Drafted |
| Architecture | Drafted; the engine integration path is verified against a live T3 Code server |
| Prompts | Architecture drafted; base prompt at v0 |
| Design language | Direction drafted; no mockups yet |
| Code | Not started |

## Read next

- [Vision and principles](docs/vision.md)
- [Product concepts](docs/product/concepts.md)
- [Architecture overview](docs/architecture/overview.md)
- [Roadmap](docs/roadmap.md)
- [Open questions](docs/open-questions.md)
- [Full documentation index](docs/README.md)

## License

Roster is intended to be free software under a GNU license. The repository currently carries GPL-3.0; whether to publish under AGPL-3.0-or-later instead is an [open decision](docs/decisions/0008-license.md).

T3 Code is MIT licensed and is not affiliated with this project.
