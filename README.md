# J3 Bots

J3 Bots gives you a small team of persistent AI teammates ("bots") that run on your own machine, on the model subscriptions you already pay for.

Each bot has a name, a job, one ongoing conversation with you, and its own memory. Bots keep working when you close the app. They wake up on a schedule or when something happens, message each other, and work together in group chats. You talk to them from a browser, a desktop app, or a phone.

J3 Bots does not run models itself. It drives an unmodified [T3 Code](https://github.com/pingdotgg/t3code) server as its engine. T3 Code already knows how to run Claude Code, Codex and other agent harnesses on your subscriptions, keep their threads durable, queue and steer turns, and handle approvals. J3 Bots adds the layer above: bots, conversations, memory, routines, bot-to-bot messaging, group chats and clients built for talking to teammates instead of managing coding threads.

## Status

Early. The install command below installs the latest published release; what each release contains and what does not work yet is in its [release notes](docs/releases/). To run unreleased code, install [from a checkout](docs/operations/install.md#from-a-checkout).

| Area        | State                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server      | Runs bots on Claude Code and Codex: conversations, memory, approvals, routines on a schedule or a webhook, bot-to-bot messages and rooms. Installs as a systemd user service on x64 and arm64 Linux, and updates itself with a snapshot to roll back to. |
| Web client  | Served by the server; installable as an app over HTTPS.                                                                                                                                                                                                  |
| Desktop app | Builds for Linux, macOS and Windows, unsigned. Runs the bots on the computer it is open on, or connects to a server.                                                                                                                                     |
| Mobile app  | An Expo app: pairing, the roster, conversations, and sending to a bot from the share sheet. Each release has a signed Android APK to [install on the phone](docs/architecture/clients.md#installing-the-android-app).                                    |
| Engine      | Pinned to one T3 Code release, in [`engine.json`](engine.json).                                                                                                                                                                                          |

## Quick start

**On this computer.** Download the desktop app for Linux, macOS or Windows from the [latest release](https://github.com/JPSAUD501/j3-bots/releases/latest), open it and choose **Use this computer**. Your bots live on this computer and sleep when it sleeps. The first run walks you through your first bot; Settings can start the app with the system, so they are back when you sign in.

**On a server that stays on.** On a Linux machine with systemd, as the user J3 Bots will run as:

```sh
curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh | sh
j3-bots provider connect
j3-bots pair
```

If `j3-bots` is not found, `~/.local/bin` is not on your `PATH` until your next login: open a new login shell. Then open one of the addresses `pair` prints in a browser, or choose **Connect to a server** in the desktop app, and enter the code. [Installing J3 Bots](docs/operations/install.md) explains each step, the systems it supports, and how to run it on a machine that matters.

Later, `j3-bots update` moves to a newer release and puts the one before back by itself if the new one does not start; `j3-bots update --rollback` goes back on request ([Update and roll back](docs/operations/operating.md#update-and-roll-back)).

## Read next

- [Installing J3 Bots](docs/operations/install.md), then [operating it](docs/operations/operating.md) and [reaching it from elsewhere](docs/operations/exposing.md)
- [Vision and principles](docs/vision.md)
- [Product concepts](docs/product/concepts.md)
- [Architecture overview](docs/architecture/overview.md)
- [Roadmap](docs/roadmap.md)
- [Full documentation index](docs/README.md)

## License

J3 Bots is free software under the [GNU Affero General Public License, version 3 or later](LICENSE), with an [additional permission](APP-STORE-PERMISSION) for distribution through app stores. The reasoning is in [decision 0008](docs/decisions/0008-license.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

T3 Code is MIT licensed and is not affiliated with this project.
