# J3 Bots

> Design phase: this repository holds the product and architecture plan, and the foundation the code will grow from. Nothing runs a bot yet.

J3 Bots gives you a small team of persistent AI teammates ("bots") that run on your own machine, on the model subscriptions you already pay for.

Each bot has a name, a job, one ongoing conversation with you, and its own memory. Bots keep working when you close the app. They wake up on a schedule or when something happens, message each other, and work together in group chats. You talk to them from a phone, a desktop app, or a browser.

J3 Bots does not run models itself. It drives an unmodified [T3 Code](https://github.com/pingdotgg/t3code) server as its engine. T3 Code already knows how to run Claude Code, Codex and other agent harnesses on your subscriptions, keep their threads durable, queue and steer turns, and handle approvals. J3 Bots adds the layer above: bots, conversations, memory, routines, bot-to-bot messaging, group chats and clients built for talking to teammates instead of managing coding threads.

## Status

| Area             | State                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Product concepts | Drafted                                                                        |
| Architecture     | Drafted; the engine integration path is verified against a live T3 Code server |
| Prompts          | Architecture drafted; base prompt at v0.3                                      |
| Design language  | Direction drafted; no mockups yet                                              |
| Code             | Foundation: toolchain, client contract, engine interface, server skeleton      |

## Read next

- [Vision and principles](docs/vision.md)
- [Product concepts](docs/product/concepts.md)
- [Architecture overview](docs/architecture/overview.md)
- [Roadmap](docs/roadmap.md)
- [Open questions](docs/open-questions.md)
- [Full documentation index](docs/README.md)

## License

J3 Bots is free software under the [GNU Affero General Public License, version 3 or later](LICENSE), with an [additional permission](LICENSE-APP-STORE) for distribution through app stores. The reasoning is in [decision 0008](docs/decisions/0008-license.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

T3 Code is MIT licensed and is not affiliated with this project.
